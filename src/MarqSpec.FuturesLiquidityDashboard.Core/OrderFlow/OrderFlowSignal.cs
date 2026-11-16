using System.Text.Json.Serialization;

namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>The order-flow events the engine reports (REQUIREMENTS.md FR-41–FR-52).</summary>
[JsonConverter(typeof(JsonStringEnumConverter<SignalKind>))]
public enum SignalKind
{
    Iceberg,
    StackedImbalance,
    UnfinishedAuction,
    TrappedTraders,
    CvdDivergence,
    DeltaExhaustion,
    Spoof,
    LiquiditySweep,
    SinglePrints,
}

/// <summary>Which way a signal leans: what it implies for price, not who was aggressive.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<SignalBias>))]
public enum SignalBias
{
    Neutral,
    Bullish,
    Bearish,
}

/// <summary>
/// One detected order-flow event. A signal is a fact about what the feed showed, with the evidence in
/// <see cref="Detail"/>; it is never a recommendation and nothing acts on it (REQUIREMENTS.md FR-6).
/// </summary>
/// <param name="Id">Monotonic per instrument, so a client can ask for "everything after".</param>
/// <param name="PriceTicks">The level, or the low of a zone.</param>
/// <param name="PriceHighTicks">The high of a zone; equal to <paramref name="PriceTicks"/> for a single level.</param>
/// <param name="Strength">0–1: how far past its threshold the evidence went (the confidence for an iceberg).</param>
public sealed record OrderFlowSignal(
    long Id,
    SignalKind Kind,
    SignalBias Bias,
    long TimeMs,
    long PriceTicks,
    long PriceHighTicks,
    double Strength,
    string Label,
    string Detail);

/// <summary>
/// A named price. <see cref="SessionId"/> and <see cref="AsOfMs"/> are set for RIPS levels (REQUIREMENTS.md FR-63).
/// Prior session high and low carry <see cref="AsOfMs"/> of the current session open (REQUIREMENTS.md FR-65). Other levels
/// leave both null.
/// </summary>
public sealed record KeyLevel(string Name, long PriceTicks, bool IsHigh, string? SessionId = null, long? AsOfMs = null);

/// <summary>
/// Signals for one instrument, oldest id first, and in time order. Ids only grow, so a delta can send just the
/// new ones (<see cref="Since"/>). A signal whose time is strictly before the newest one already kept is not
/// stored and does not take an id: <see cref="Prune"/> and <see cref="CountAfter"/> stop at the first time that
/// is out of order, and a newer id in the middle would make <see cref="Since"/> repeat ids a client already has.
/// A live trade can still be stamped behind the last one. The print is still applied; the late signal is not.
/// A signal stays until <see cref="Prune"/> sees a clock one retention window past its time, and then only while
/// the log is within its cap. Past the cap the lowest ids are dropped, whichever kind they are. The cap is
/// clamped to 1–100,000 (<see cref="OrderFlowOptions.MaxSignalHistoryCap"/>, ARCHITECTURE.md D-41): below 1 keeps
/// the newest signal, and a larger request is that ceiling.
/// </summary>
public sealed class SignalLog
{
    private readonly long _retentionMs;
    private readonly int _cap;
    private readonly List<OrderFlowSignal> _signals = [];
    private long _lastId;
    private long _lateDropped;

    /// <summary>Signals refused because their time was strictly before the newest one already kept.</summary>
    public long LateDropped => _lateDropped;

    public SignalLog(long retentionMs, int cap)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(retentionMs);
        _retentionMs = retentionMs;
        _cap = OrderFlowOptions.ClampSignalHistoryCap(cap);
    }

    public long LastId => _lastId;

    /// <summary>The newest retained signal, or null when the log is empty. The list is not copied.</summary>
    public OrderFlowSignal? Newest => _signals.Count == 0 ? null : _signals[^1];

    /// <summary>Every retained signal in id order.</summary>
    public IReadOnlyList<OrderFlowSignal> All => _signals.ToList();

    /// <summary>
    /// How many retained signals have a time strictly after <paramref name="timeMs"/>. Walks back from the newest
    /// and stops at the first one that is not, because the log is oldest-time first.
    /// </summary>
    public int CountAfter(long timeMs)
    {
        var count = 0;
        for (var i = _signals.Count - 1; i >= 0; i--)
        {
            if (_signals[i].TimeMs <= timeMs)
            {
                break;
            }

            count++;
        }

        return count;
    }

    /// <summary>The newest <paramref name="count"/> signals, in id order. Copies only that tail.</summary>
    public IReadOnlyList<OrderFlowSignal> TakeLast(int count)
    {
        if (count <= 0 || _signals.Count == 0)
        {
            return [];
        }

        var start = Math.Max(0, _signals.Count - count);
        var taken = new OrderFlowSignal[_signals.Count - start];
        _signals.CopyTo(start, taken, 0, taken.Length);
        return taken;
    }

    public OrderFlowSignal? Add(SignalKind kind, SignalBias bias, long timeMs, long low, long high, double strength, string label, string detail)
    {
        // Behind the newest time. Appending it leaves a stale tail and makes CountAfter stop early.
        if (_signals.Count > 0 && timeMs < _signals[^1].TimeMs)
        {
            _lateDropped++;
            return null;
        }

        var signal = new OrderFlowSignal(++_lastId, kind, bias, timeMs, Math.Min(low, high), Math.Max(low, high),
            Math.Round(Math.Clamp(strength, 0, 1), 3), label, detail);
        _signals.Add(signal);
        Prune(timeMs);
        return signal;
    }

    /// <summary>
    /// Drops the prefix older than <paramref name="nowMs"/> minus the retention, then the oldest ids past the cap.
    /// Stops at the first signal still inside the window, because the log is oldest-time first.
    /// </summary>
    public void Prune(long nowMs)
    {
        var count = _signals.Count;
        if (count == 0)
        {
            return;
        }

        var cutoff = nowMs < _retentionMs ? long.MinValue : nowMs - _retentionMs;
        if (_signals[0].TimeMs >= cutoff && count <= _cap)
        {
            return;
        }

        var first = 0;
        while (first < count && _signals[first].TimeMs < cutoff)
        {
            first++;
        }

        if (first > 0)
        {
            _signals.RemoveRange(0, first);
        }

        var extra = _signals.Count - _cap;
        if (extra > 0)
        {
            _signals.RemoveRange(0, extra);
        }
    }

    /// <summary>Retained signals whose time is at or after <paramref name="fromMs"/>, in id order. The live delta does not use this.</summary>
    public IReadOnlyList<OrderFlowSignal> InWindow(long fromMs)
    {
        var kept = new List<OrderFlowSignal>();
        foreach (var signal in _signals)
        {
            if (signal.TimeMs >= fromMs)
            {
                kept.Add(signal);
            }
        }

        return kept;
    }

    public IReadOnlyList<OrderFlowSignal> Since(long afterId)
    {
        var start = 0;
        while (start < _signals.Count && _signals[start].Id <= afterId)
        {
            start++;
        }

        if (start == 0)
        {
            return _signals.ToList();
        }

        var taken = new OrderFlowSignal[_signals.Count - start];
        _signals.CopyTo(start, taken, 0, taken.Length);
        return taken;
    }
}
