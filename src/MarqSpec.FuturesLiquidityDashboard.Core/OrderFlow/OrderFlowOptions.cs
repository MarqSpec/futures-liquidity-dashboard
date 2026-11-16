namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>
/// Every threshold and window the order-flow detectors use (REQUIREMENTS.md FR-41–FR-52, ARCHITECTURE.md D-19–D-24). The
/// defaults are starting points chosen for 1-minute footprints on ES, GC and CL; each is bound from configuration
/// (<c>Engine:OrderFlow</c>) so a desk can tune them without a code change, and each detector can be switched off.
/// </summary>
public sealed record OrderFlowOptions
{
    /// <summary>Footprint bar length; the delta, trap, exhaustion and divergence detectors run on these bars.</summary>
    public int FootprintSeconds { get; init; } = 60;

    /// <summary>Closed footprint bars kept for snapshots.</summary>
    public int FootprintRetentionBars { get; init; } = 60;

    /// <summary>Diagonal imbalance: ask volume at P against bid volume at P−1 (and bid at P against ask at P+1).</summary>
    public double ImbalanceRatio { get; init; } = 3.0;

    /// <summary>The dominant side of an imbalance needs at least this many contracts.</summary>
    public long ImbalanceMinVolume { get; init; } = 4;

    /// <summary>Consecutive imbalanced ticks that make a stacked imbalance zone.</summary>
    public int StackedMinLevels { get; init; } = 3;

    /// <summary>Non-empty footprint bars in the rolling delta distribution.</summary>
    public int DeltaLookbackBars { get; init; } = 20;

    /// <summary>A bar's delta is a spike when it is this many standard deviations from the rolling mean.</summary>
    public double DeltaSpikeSigma { get; init; } = 2.0;

    /// <summary>Bars needed in the distribution before any spike is called.</summary>
    public int DeltaMinSamples { get; init; } = 8;

    /// <summary>"Near a key level": the bar's extreme within this many ticks of one.</summary>
    public int KeyLevelProximityTicks { get; init; } = 4;

    /// <summary>Trapped traders: the reversal must close beyond the spike bar's far extreme within this many bars.</summary>
    public int TrappedReversalBars { get; init; } = 2;

    /// <summary>Delta exhaustion: a buying spike closing in the lower fraction of its range (or the mirror) stalled.</summary>
    public double ExhaustionCloseFraction { get; init; } = 0.4;

    /// <summary>Swing pivots: bars on each side a pivot must exceed. Used by CVD divergence and sweep levels.</summary>
    public int SwingStrengthBars { get; init; } = 3;

    /// <summary>Two pivots further apart than this are not compared for divergence.</summary>
    public int DivergenceMaxBars { get; init; } = 90;

    /// <summary>Spoof: a level at least this multiple of the median resting level counts as large.</summary>
    public double SpoofMinMultiple { get; init; } = 3.0;

    /// <summary>Spoof: pulled while the market was within this many ticks of it.</summary>
    public int SpoofProximityTicks { get; init; } = 4;

    /// <summary>Spoof: at most this fraction of the peak size traded before the pull.</summary>
    public double SpoofMaxFilledFraction { get; init; } = 0.15;

    /// <summary>Spoof: at least this fraction of the peak size cancelled rather than filled.</summary>
    public double SpoofMinPulledFraction { get; init; } = 0.6;

    /// <summary>Spoof: the order must have rested at least this long, so ordinary flicker is not called a spoof.</summary>
    public int SpoofMinRestMs { get; init; } = 2_000;

    /// <summary>Sweep: ticks traded beyond a key level before it counts as breached.</summary>
    public int SweepMinTicksBeyond { get; init; } = 1;

    /// <summary>Sweep: price must trade back through the level within this long, or it was a breakout.</summary>
    public int SweepReturnMs { get; init; } = 120_000;

    /// <summary>Iceberg: a refill is a size increase at the level within this long after a print there.</summary>
    public int IcebergRefillWindowMs { get; init; } = 1_500;

    /// <summary>Iceberg: refills needed before a level can be called an iceberg.</summary>
    public int IcebergMinRefills { get; init; } = 2;

    /// <summary>Iceberg: volume traded at the level as a multiple of the most ever displayed there at once.</summary>
    public double IcebergMinTradedMultiple { get; init; } = 1.25;

    /// <summary>Iceberg: confidence (0–1) needed to report.</summary>
    public double IcebergMinConfidence { get; init; } = 0.35;

    /// <summary>Iceberg: an episode with no print for this long is closed.</summary>
    public int IcebergIdleMs { get; init; } = 60_000;

    /// <summary>Iceberg: a closed detection stays listed for this long.</summary>
    public int IcebergRetainMs { get; init; } = 180_000;

    /// <summary>Volume profile nodes: half-width of the smoothing window, in ticks.</summary>
    public int NodeSmoothingTicks { get; init; } = 2;

    /// <summary>HVN: smoothed volume at least this multiple of the profile's mean.</summary>
    public double HvnMultiple { get; init; } = 1.5;

    /// <summary>LVN: smoothed volume at most this multiple of the profile's mean.</summary>
    public double LvnMultiple { get; init; } = 0.5;

    /// <summary>Nodes of each kind reported per profile.</summary>
    public int MaxNodes { get; init; } = 5;

    /// <summary>TPO period length (one letter per period).</summary>
    public int TpoPeriodMinutes { get; init; } = 30;

    /// <summary>TPO row height in ticks; 0 picks the instrument default (ES 4, GC 10, CL 5).</summary>
    public int TpoRowTicks { get; init; }

    /// <summary>Consecutive single-TPO rows that make a single-print run.</summary>
    public int SinglePrintMinRows { get; init; } = 2;

    /// <summary>Highest <see cref="SignalHistoryCap"/> that is kept. A larger configured value is read as this (ARCHITECTURE.md D-41).</summary>
    public const int MaxSignalHistoryCap = 100_000;

    /// <summary>Reads a cap into 1…<see cref="MaxSignalHistoryCap"/>.</summary>
    public static int ClampSignalHistoryCap(int cap) => Math.Clamp(cap, 1, MaxSignalHistoryCap);

    /// <summary>
    /// Most signals one instrument keeps, across every kind. Older than <c>Engine:HistoryRetentionMinutes</c> are
    /// dropped first; past this cap the lowest ids go. The snapshot sends the ones inside the requested history.
    /// The default matches the client's 20,000. A value below 1 is read as 1 and a value above
    /// <see cref="MaxSignalHistoryCap"/> is read as that ceiling (ARCHITECTURE.md D-41). <c>SignalRetention</c> is not read.
    /// </summary>
    public int SignalHistoryCap { get; init; } = 20_000;

    public bool EnableIcebergs { get; init; } = true;

    public bool EnableStackedImbalances { get; init; } = true;

    public bool EnableUnfinishedAuctions { get; init; } = true;

    public bool EnableTrappedTraders { get; init; } = true;

    public bool EnableCvdDivergence { get; init; } = true;

    public bool EnableDeltaExhaustion { get; init; } = true;

    public bool EnableSpoofs { get; init; } = true;

    public bool EnableSweeps { get; init; } = true;

    public bool EnableSinglePrints { get; init; } = true;

    public static OrderFlowOptions Default { get; } = new();
}
