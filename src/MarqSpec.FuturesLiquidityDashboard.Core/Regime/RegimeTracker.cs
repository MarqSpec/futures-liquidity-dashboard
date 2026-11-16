using System.Text.Json.Serialization;
using MarqSpec.FuturesLiquidityDashboard.Core.Bars;
using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Regime;

/// <summary>Trending or ranging (REQUIREMENTS.md FR-56). Other regime kinds (for example volatility) get their own field.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<TrendRegime>))]
public enum TrendRegime
{
    /// <summary>Not enough bars yet.</summary>
    Unknown,
    Ranging,

    /// <summary>Between the trend and range thresholds, or trend strength without an agreed direction.</summary>
    Transition,
    TrendingUp,
    TrendingDown,
}

/// <summary>
/// One timeframe's regime with the inputs that decided it (INTERFACES.md D.1). Prices are in ticks. New regime
/// kinds are added as new fields, so older clients keep reading <see cref="Trend"/>.
/// </summary>
public sealed record RegimeDto(
    int TimeframeSeconds,
    TrendRegime Trend,
    bool Ready,
    int SeenBars,
    int WarmupBars,
    double? Adx,
    double? PlusDi,
    double? MinusDi,
    double? EfficiencyRatio,
    double? EmaFast,
    double? EmaSlow,
    long? SinceMs);

/// <summary>
/// Classifies one bar timeframe as trending or ranging from closed bars (REQUIREMENTS.md FR-56). The rule is mechanical:
/// <list type="bullet">
/// <item>Trending when ADX ≥ <see cref="RegimeOptions.TrendAdx"/> and the efficiency ratio ≥
/// <see cref="RegimeOptions.TrendEfficiency"/>; up when +DI &gt; −DI and the fast EMA is above the slow one (the DI
/// alone until the slow EMA is ready), down for the mirror, and Transition when they disagree.</item>
/// <item>Ranging when ADX ≤ <see cref="RegimeOptions.RangeAdx"/> and the efficiency ratio ≤
/// <see cref="RegimeOptions.RangeEfficiency"/>.</item>
/// <item>Transition for anything between, so the label does not flicker at one threshold.</item>
/// </list>
/// Bars with no trades are skipped, so a quiet overnight does not read as a range. Not thread-safe.
/// </summary>
public sealed class RegimeTracker
{
    private readonly RegimeOptions _options;
    private readonly BarAggregator _bars;
    private readonly Adx _adx;
    private readonly EfficiencyRatio _efficiency;
    private readonly Ema _fast;
    private readonly Ema _slow;
    private TrendRegime _trend = TrendRegime.Unknown;
    private long? _sinceMs;
    private int _seen;

    public RegimeTracker(int timeframeSeconds, RegimeOptions options)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(timeframeSeconds, 1);
        _options = options ?? throw new ArgumentNullException(nameof(options));
        TimeframeSeconds = timeframeSeconds;
        _bars = new BarAggregator(timeframeSeconds * 1000);
        _adx = new Adx(options.AdxPeriod);
        _efficiency = new EfficiencyRatio(options.EfficiencyPeriod);
        _fast = new Ema(options.EmaFast);
        _slow = new Ema(options.EmaSlow);
    }

    public int TimeframeSeconds { get; }

    /// <summary>Closed bars needed before the trend-versus-range call (ADX and efficiency ratio ready).</summary>
    public int WarmupBars => _options.WarmupBars;

    public TrendRegime Trend => _trend;

    public void AddTrade(long timeMs, long priceTicks, long quantity, bool buyerAggressor)
    {
        foreach (var bar in _bars.Add(timeMs, priceTicks, quantity, buyerAggressor))
        {
            OnBar(bar);
        }
    }

    public void AdvanceTo(long timeMs)
    {
        foreach (var bar in _bars.AdvanceTo(timeMs))
        {
            OnBar(bar);
        }
    }

    public RegimeDto State() => new(
        TimeframeSeconds, _trend, _trend != TrendRegime.Unknown, _seen, WarmupBars,
        Round(_adx.Value), Round(_adx.PlusDi), Round(_adx.MinusDi), Round(_efficiency.Value, 3), Round(_fast.Value), Round(_slow.Value), _sinceMs);

    /// <summary>The rule itself, on its inputs (null while warming up).</summary>
    public static TrendRegime Classify(
        double? adx,
        double? plusDi,
        double? minusDi,
        double? efficiency,
        double? emaFast,
        double? emaSlow,
        RegimeOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (adx is not { } a || efficiency is not { } er || plusDi is not { } plus || minusDi is not { } minus)
        {
            return TrendRegime.Unknown;
        }

        if (a >= options.TrendAdx && er >= options.TrendEfficiency)
        {
            var emaUp = emaFast is { } f && emaSlow is { } s ? f > s : (bool?)null;
            return plus > minus && emaUp != false ? TrendRegime.TrendingUp
                : minus > plus && emaUp != true ? TrendRegime.TrendingDown
                : TrendRegime.Transition;
        }

        return a <= options.RangeAdx && er <= options.RangeEfficiency ? TrendRegime.Ranging : TrendRegime.Transition;
    }

    private void OnBar(TradeBar bar)
    {
        if (bar.IsEmpty || bar.High is not { } high || bar.Low is not { } low || bar.Close is not { } close)
        {
            return;
        }

        _seen++;
        _adx.Update(high, low, close);
        _efficiency.Update(close);
        _fast.Update(close);
        _slow.Update(close);
        var next = Classify(_adx.Value, _adx.PlusDi, _adx.MinusDi, _efficiency.Value, _fast.Value, _slow.Value, _options);
        if (next != _trend)
        {
            _trend = next;
            _sinceMs = bar.EndMs;
        }
    }

    private static double? Round(double? value, int decimals = 2) => value is { } v ? Math.Round(v, decimals) : null;
}
