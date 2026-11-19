using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Regime;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Engine;

/// <summary>Per-instrument engine limits and defaults (REQUIREMENTS.md FR-1, FR-2, NFR-1, NFR-4).</summary>
public sealed record EngineOptions
{
    /// <summary>The shared grid's base slice; 5 s views re-aggregate it (REQUIREMENTS.md FR-1).</summary>
    public int SliceMs { get; init; } = 1000;

    /// <summary>Retained history of the 1-second slices and bars the detectors read (REQUIREMENTS.md FR-2).</summary>
    public int RetentionMinutes { get; init; } = 60;

    /// <summary>
    /// Retained minute bars and minute heatmap columns the chart re-aggregates (1/2/5/15). Three sessions, well past
    /// the 60-minute slice window.
    /// </summary>
    public int HistoryRetentionMinutes { get; init; } = 3 * 24 * 60;

    /// <summary>STALE after this long without feed activity during an open session (REQUIREMENTS.md NFR-1).</summary>
    public int StaleAfterMs { get; init; } = 3000;

    /// <summary>Least and most price levels per side sent for the ladder.</summary>
    public const int MinLadderLevels = 5;

    /// <summary>Upper bound, the same ceiling as <c>Feed:ProjectX:LevelsPerSide</c>.</summary>
    public const int MaxLadderLevels = 200;

    /// <summary>
    /// Price levels per side sent for the ladder. A book with fewer prices is sent as it arrived:
    /// nothing is padded and a missing price is not a zero row (REQUIREMENTS.md FR-11).
    /// </summary>
    public int LadderLevels { get; init; } = 40;

    /// <summary>Live prints kept for the tape (REQUIREMENTS.md FR-59, NFR-4). The oldest are dropped; nothing is invented.</summary>
    public int PrintCapacity { get; init; } = 4_096;

    public IndicatorSettings Indicators { get; init; } = IndicatorSettings.Default;

    /// <summary>Order-flow detector thresholds and switches (REQUIREMENTS.md FR-41–FR-52).</summary>
    public OrderFlowOptions OrderFlow { get; init; } = OrderFlowOptions.Default;

    /// <summary>Trend-versus-range classification per bar timeframe (REQUIREMENTS.md FR-56).</summary>
    public RegimeOptions Regime { get; init; } = RegimeOptions.Default;

    public static EngineOptions Default { get; } = new();
}
