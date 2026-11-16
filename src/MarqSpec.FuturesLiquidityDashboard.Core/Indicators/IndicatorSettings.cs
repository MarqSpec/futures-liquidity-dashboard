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

    public static IndicatorSettings Default { get; } = new();
}
