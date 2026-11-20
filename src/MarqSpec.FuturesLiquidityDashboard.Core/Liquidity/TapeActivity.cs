using System.Text.Json.Serialization;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;

/// <summary>
/// The <c>Engine:Tape</c> configuration section (REQUIREMENTS.md FR-83): how long the trade-rate baseline is and what share of it
/// marks the tape thin.
/// </summary>
public sealed record TapeOptions
{
    /// <summary>Least and most minutes the baseline may cover.</summary>
    public const int MinBaselineMinutes = 1;

    public const int MaxBaselineMinutes = 24 * 60;

    /// <summary>Minutes of 10 s trade-rate samples whose median is the baseline.</summary>
    public int BaselineMinutes { get; init; } = 30;

    /// <summary>The tape is thin while the trade rate is strictly under this share of the baseline; (0, 1].</summary>
    public double ThinRatio { get; init; } = 0.25;

    public static TapeOptions Default { get; } = new();
}

/// <summary>How busy the tape is against its own recent baseline (REQUIREMENTS.md FR-83). Describes activity, never direction.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<TapeState>))]
public enum TapeState
{
    /// <summary>
    /// No reading: less than the window seen yet, more than half of it without a print, the 10 s rate window still
    /// holding warmup, or (set by the engine) a feed that is RECOVERING or STALE or an exchange that is closed.
    /// </summary>
    Unknown,

    Active,

    Thin,
}

/// <summary>
/// One tape-activity reading (REQUIREMENTS.md FR-83). <paramref name="Rate"/> is FR-39's trade rate: live contracts in the last
/// 10 s over 10. <paramref name="BaselineRate"/> is the median of the window's 10 s rates and <paramref name="ThinBelowRate"/>
/// the share of it the rate must stay at or above; both null when <paramref name="State"/> is Unknown.
/// </summary>
public sealed record TapeReading(TapeState State, double Rate, double? BaselineRate, double? ThinBelowRate, int BaselineMinutes);

/// <summary>
/// Trade rate against the product's own recent median (REQUIREMENTS.md FR-83, ARCHITECTURE.md D-70). Every applied print counts,
/// warmup history included, into 10 s spans aligned to the epoch; the baseline is the median of the
/// <see cref="TapeOptions.BaselineMinutes"/> of complete spans before the current one, empty spans counting as zero. The
/// rate counts live prints only, so it is FR-39's trade rate, and there is no reading while its 10 s window still
/// holds a warmup print. The clock is the latest time seen. Not thread-safe: the engine's lock covers it, and nothing
/// here does I/O.
/// </summary>
public sealed class TapeActivity
{
    /// <summary>The trade-rate window and the baseline's sample length: FR-39's 10 s.</summary>
    public const long RateWindowMs = 10_000;

    private readonly TapeOptions _options;
    private readonly int _spans;
    private readonly long[] _spanIds;
    private readonly long[] _spanSums;
    private readonly Queue<(long TimeMs, long Quantity)> _recent = new();
    private long _nowMs = long.MinValue;
    private long _firstSpan = long.MaxValue;
    private long _lastWarmupMs = long.MinValue;
    private long _medianSpan = long.MinValue;
    private double _median;

    public TapeActivity(TapeOptions options)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _spans = (int)(Math.Max(TapeOptions.MinBaselineMinutes, options.BaselineMinutes) * 60_000L / RateWindowMs);
        _spanIds = new long[_spans + 1];
        _spanSums = new long[_spans + 1];
        Array.Fill(_spanIds, long.MinValue);
    }

    /// <summary>
    /// Counts a print at <paramref name="timeMs"/> toward the baseline, and toward the rate when it is
    /// <paramref name="live"/>, and moves the clock to it if it is later.
    /// </summary>
    public void Add(long timeMs, long quantity, bool live = true)
    {
        AdvanceTo(timeMs);
        var span = Span(timeMs);
        var current = Span(_nowMs);
        if (span <= current - _spans - 1)
        {
            return;
        }

        var slot = Slot(span);
        if (_spanIds[slot] != span)
        {
            _spanIds[slot] = span;
            _spanSums[slot] = 0;
        }

        _spanSums[slot] += quantity;
        if (span < current)
        {
            // A late print changed a complete span the cached median was taken over.
            _medianSpan = long.MinValue;
        }

        if (!live)
        {
            _lastWarmupMs = Math.Max(_lastWarmupMs, timeMs);
        }
        else if (timeMs > _nowMs - RateWindowMs)
        {
            _recent.Enqueue((timeMs, quantity));
        }
    }

    /// <summary>Moves the clock forward; an earlier time is ignored.</summary>
    public void AdvanceTo(long timeMs)
    {
        if (_nowMs == long.MinValue)
        {
            _firstSpan = Span(timeMs);
        }

        if (timeMs <= _nowMs)
        {
            return;
        }

        _nowMs = timeMs;
        while (_recent.Count > 0 && _recent.Peek().TimeMs <= _nowMs - RateWindowMs)
        {
            _recent.Dequeue();
        }
    }

    /// <summary>The state at the clock: Unknown without a baseline, else Thin when the rate is under the share of it.</summary>
    public TapeReading Reading()
    {
        long quantity = 0;
        foreach (var (time, q) in _recent)
        {
            // A late print queued behind a newer one outlives the head-only pruning.
            if (time > _nowMs - RateWindowMs)
            {
                quantity += q;
            }
        }

        var rate = quantity / (RateWindowMs / 1000.0);
        if (_nowMs == long.MinValue || Span(_nowMs) - _spans < _firstSpan || _lastWarmupMs > _nowMs - RateWindowMs)
        {
            return new TapeReading(TapeState.Unknown, rate, null, null, _options.BaselineMinutes);
        }

        var median = Median(Span(_nowMs));
        if (median <= 0)
        {
            return new TapeReading(TapeState.Unknown, rate, null, null, _options.BaselineMinutes);
        }

        var thinBelow = median * _options.ThinRatio;
        return new TapeReading(rate < thinBelow ? TapeState.Thin : TapeState.Active, rate, median, thinBelow, _options.BaselineMinutes);
    }

    private double Median(long current)
    {
        if (_medianSpan == current)
        {
            return _median;
        }

        var samples = new long[_spans];
        for (var i = 0; i < _spans; i++)
        {
            var span = current - _spans + i;
            var slot = Slot(span);
            samples[i] = _spanIds[slot] == span ? _spanSums[slot] : 0;
        }

        Array.Sort(samples);
        var mid = _spans / 2;
        var middle = _spans % 2 == 1 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2.0;
        _median = middle / (RateWindowMs / 1000.0);
        _medianSpan = current;
        return _median;
    }

    private static long Span(long timeMs)
    {
        var span = timeMs / RateWindowMs;
        return timeMs % RateWindowMs < 0 ? span - 1 : span;
    }

    private int Slot(long span) => (int)(((span % _spanIds.Length) + _spanIds.Length) % _spanIds.Length);
}
