namespace MarqSpec.FuturesLiquidityDashboard.Core.Engine;

/// <summary>The history request that covers every unsettled hole. <see cref="ToMs"/> is exclusive.</summary>
public readonly record struct GapRepairWindow(bool Pending, long FromMs, long ToMs);

/// <summary>
/// What one repair apply did. <see cref="Completed"/> is true only when every hole's end is covered by a returned
/// closed bar. A non-zero <see cref="MinutesWritten"/> is not enough (ARCHITECTURE.md D-33).
/// </summary>
public readonly record struct GapRepairResult(bool Completed, int MinutesWritten);
