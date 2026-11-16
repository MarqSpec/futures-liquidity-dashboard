namespace MarqSpec.FuturesLiquidityDashboard.Core.Market;

/// <summary>
/// One closed one-minute bar from history. It has no aggressor: the volume is the bar's total, and a repair
/// writes it into that minute's own bin instead of replaying it as trades (ARCHITECTURE.md D-33).
/// </summary>
public readonly record struct HistoricalMinuteBar(
    long StartMs,
    long OpenTicks,
    long HighTicks,
    long LowTicks,
    long CloseTicks,
    long Volume);
