namespace MarqSpec.FuturesLiquidityDashboard.Core.Plans;


/// <summary>A profit target of a plan: a price in ticks and the contracts it takes off.</summary>
public sealed record PlanTarget(long PriceTicks, int Quantity);

/// <summary>
/// The prices of a simulated plan (REQUIREMENTS.md FR-72), already validated by the caller: for a long the stop is below the
/// entry and every target above it, and a short is the mirror image. Prices are whole ticks. It is an annotation the
/// metrics describe, never an instruction to a broker (REQUIREMENTS.md FR-6).
/// </summary>
/// <param name="IsLong">True for a long, false for a short.</param>
/// <param name="IsMarket">True for a market entry, false for a limit entry.</param>
/// <param name="EntryTicks">The limit price, or the price a market entry was drawn at; null for a market entry drawn at no price.</param>
public sealed record PlanSpec(
    bool IsLong,
    bool IsMarket,
    long? EntryTicks,
    int Quantity,
    long StopTicks,
    IReadOnlyList<PlanTarget> Targets);
