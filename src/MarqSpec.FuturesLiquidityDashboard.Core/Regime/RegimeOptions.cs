namespace MarqSpec.FuturesLiquidityDashboard.Core.Regime;

/// <summary>
/// The <c>Engine:Regime</c> configuration section (REQUIREMENTS.md FR-56; DEPLOYMENT.md §3): the bar timeframes the regime is
/// classified on and the inputs and thresholds of the trend-versus-range rule.
/// </summary>
public sealed record RegimeOptions
{
    /// <summary>Bar lengths, in seconds, each classified on its own (5 and 15 minutes by default).</summary>
    public IReadOnlyList<int> TimeframesSeconds { get; init; } = [300, 900];

    public int AdxPeriod { get; init; } = 14;

    public int EfficiencyPeriod { get; init; } = 20;

    /// <summary>Fast and slow EMAs whose order gives a trend's direction.</summary>
    public int EmaFast { get; init; } = 13;

    public int EmaSlow { get; init; } = 48;

    /// <summary>Trending needs ADX at or above this and the efficiency ratio at or above <see cref="TrendEfficiency"/>.</summary>
    public double TrendAdx { get; init; } = 25;

    public double TrendEfficiency { get; init; } = 0.30;

    /// <summary>Ranging needs ADX at or below this and the efficiency ratio at or below <see cref="RangeEfficiency"/>.</summary>
    public double RangeAdx { get; init; } = 20;

    public double RangeEfficiency { get; init; } = 0.20;

    /// <summary>Bars a timeframe needs before it is classified: ADX needs two periods, the efficiency ratio one more close.</summary>
    public int WarmupBars => Math.Max(2 * AdxPeriod, EfficiencyPeriod + 1);

    /// <summary>History the slowest timeframe needs to warm up, in hours (28 fifteen-minute bars = 7 h by default).</summary>
    public double WarmupHours => TimeframesSeconds.Count == 0 ? 0 : TimeframesSeconds.Max() * (double)WarmupBars / 3600;

    public static RegimeOptions Default { get; } = new();
}
