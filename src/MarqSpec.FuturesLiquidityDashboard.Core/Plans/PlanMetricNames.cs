namespace MarqSpec.FuturesLiquidityDashboard.Core.Plans;


/// <summary>
/// The names a feedback claim may cite (REQUIREMENTS.md FR-74), one per FR-73 metric of definitions version
/// <see cref="PlanMetrics.CurrentDefinitionsVersion"/>. A name is the metric's camelCase field path in
/// <see cref="PlanMetrics"/>; the two trade-through windows are told apart by their bar count. Adding or renaming one
/// is a definitions change, so it raises the version with them.
/// </summary>
public static class PlanMetricNames
{
    /// <summary>Metrics measured for each leg.</summary>
    public static IReadOnlyList<string> Leg { get; } =
    [
        "distanceTicks",
        "distanceAtr",
        "restingAhead.now",
        "restingAhead.mean10m",
        "restingAhead.coverage10m",
        "throughFrequency.60",
        "throughFrequency.240",
        "lastReachedMs",
        "inTheWay",
        "keyLevels",
        "flow.sessionDeltaAtPrice",
        "flow.zones",
        "flow.unfinishedAuctions",
        "flow.signals",
    ];

    /// <summary>Metrics measured once for the plan.</summary>
    public static IReadOnlyList<string> Plan { get; } =
    [
        "lastTicks",
        "atrTicks",
        "statusCode",
        "rewardRisk",
        "stopAtr",
        "stopPlacement",
        "marketSlippage",
        "regimes",
        "coverage",
    ];

    /// <summary>Every citeable name, in the order above.</summary>
    public static IReadOnlyList<string> All { get; } = [.. Leg, .. Plan];

    private static readonly HashSet<string> Known = new(All, StringComparer.Ordinal);

    /// <summary>True only for an exact, case-sensitive name in <see cref="All"/>.</summary>
    public static bool IsKnown(string? name) => name is not null && Known.Contains(name);
}
