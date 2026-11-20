namespace MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

/// <summary>One EMA: its own period and source timeframe (REQUIREMENTS.md FR-16).</summary>
public sealed record EmaSetting(int Period, int TimeframeSeconds = 60);

public sealed record RsiSetting(int Period = 14, int TimeframeSeconds = 60);

public sealed record MacdSetting(int Fast = 12, int Slow = 26, int Signal = 9, int TimeframeSeconds = 60);

public sealed record AtrSetting(int Period = 14, int TimeframeSeconds = 60);

/// <summary>
/// The indicator set of ARCHITECTURE.md D-9 with the proposed defaults of REQUIREMENTS.md FR-19–FR-21. The default source
/// timeframe of one minute for every indicator is decision D-13 (the maintainer may change any one independently).
/// </summary>
public sealed record IndicatorSettings
{
    public IReadOnlyList<EmaSetting> Emas { get; init; } =
        [new(10), new(13), new(24), new(48), new(200)];

    public RsiSetting Rsi { get; init; } = new();

    public MacdSetting Macd { get; init; } = new();

    public AtrSetting Atr { get; init; } = new();

    /// <summary>
    /// One-minute bars of history that seed the slowest EMA, the longest period, on a source of
    /// <paramref name="sourceSeconds"/>: one source bar more than the period, in whole minutes (REQUIREMENTS.md FR-17, D-68).
    /// The extra bar is the one holding the last history print, which is still forming when history ends. Zero with
    /// no EMA configured.
    /// </summary>
    public int EmaWarmupMinutes(int sourceSeconds)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(sourceSeconds, 1);
        return Emas.Count == 0 ? 0 : (Emas.Max(e => e.Period) + 1) * ((sourceSeconds + 59) / 60);
    }

    public static IndicatorSettings Default { get; } = new();
}
