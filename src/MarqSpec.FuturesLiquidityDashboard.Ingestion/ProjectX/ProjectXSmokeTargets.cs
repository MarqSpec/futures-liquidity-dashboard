using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

/// <summary>
/// The products <c>live-smoke</c> reads. The catalog lists every product (D-26); the smoke command stays on the
/// three default tabs (D-28) so one login does not subscribe the whole gateway list.
/// </summary>
public static class ProjectXSmokeTargets
{
    public static IReadOnlyList<InstrumentRoot> Roots { get; } = [InstrumentRoot.MES, InstrumentRoot.MCL, InstrumentRoot.MGC];
}
