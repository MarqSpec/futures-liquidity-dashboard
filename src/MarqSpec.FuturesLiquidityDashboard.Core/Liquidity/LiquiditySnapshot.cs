using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;

/// <summary>Resting quantity summed over the top N levels and the imbalance between the two sides.</summary>
public sealed record DepthReading(int Levels, long Bid, long Ask)
{
    /// <summary>(bid − ask) / (bid + ask), in [−1, 1]; null when both sides are empty.</summary>
    public double? Imbalance => Bid + Ask == 0 ? null : (double)(Bid - Ask) / (Bid + Ask);
}

/// <summary>A resting level well above its neighbours, and how long it has stayed (a "wall").</summary>
public sealed record LiquidityWall(BookSide Side, long PriceTicks, long Quantity, long AgeMs);

/// <summary>How a wall's size left when it stopped being a wall (REQUIREMENTS.md FR-78). Says nothing about intent.</summary>
public enum WallOutcome
{
    /// <summary>Most of the size that left traded: FR-38 filled at least pulled.</summary>
    Filled,

    /// <summary>Most of the size that left was removed without trading: FR-38 pulled above filled.</summary>
    Pulled,

    /// <summary>At least half its peak still rests; it no longer clears the wall threshold.</summary>
    BelowThreshold,
}

/// <summary>A reported wall that stopped being one: where it stood, for how long, and how its size left (REQUIREMENTS.md FR-78).</summary>
/// <param name="PeakQuantity">The largest size the level showed while it was a wall.</param>
/// <param name="Filled">Decreases FR-38 matched to prints while it was a wall.</param>
/// <param name="Pulled">Decreases FR-38 did not match to prints while it was a wall.</param>
/// <param name="StoodMs">From when it became a wall to when it stopped being one.</param>
/// <param name="EndedMs">Engine time when it stopped being one.</param>
public sealed record EndedWall(BookSide Side, long PriceTicks, long PeakQuantity, long Filled, long Pulled, long StoodMs, long EndedMs, WallOutcome Outcome);

/// <summary>
/// The liquidity metrics of the dashboard, each with a fixed definition (documented in REQUIREMENTS.md FR-36–FR-40 and FR-78):
/// spread and microprice at the top of book, depth and imbalance at 1/5/10 levels, liquidity flow (added, pulled,
/// filled) over 10 s and 60 s, cumulative delta, trade rate, persistent walls and the walls that recently ended.
/// </summary>
public sealed record LiquiditySnapshot
{
    public required bool BookKnown { get; init; }

    public long? BestBid { get; init; }

    public long? BestAsk { get; init; }

    public long? BestBidQuantity { get; init; }

    public long? BestAskQuantity { get; init; }

    /// <summary>Exchange time of the quote or depth event that last set the top of book. Null when neither has arrived.</summary>
    public long? QuoteTimeMs { get; init; }

    /// <summary>True when no top of book has arrived, or it is older than the stale window (REQUIREMENTS.md FR-60).</summary>
    public bool QuoteStale { get; init; }

    public long? SpreadTicks { get; init; }

    /// <summary>Size-weighted mid: (bid × askQty + ask × bidQty) / (bidQty + askQty), in ticks.</summary>
    public double? Microprice { get; init; }

    public required IReadOnlyList<DepthReading> Depth { get; init; }

    public required FlowTotals Flow10s { get; init; }

    public required FlowTotals Flow60s { get; init; }

    /// <summary>Buy-aggressor minus sell-aggressor volume since the session anchor.</summary>
    public required long CumulativeDelta { get; init; }

    public required long Delta60s { get; init; }

    /// <summary>Executed contracts per second over the last 10 s.</summary>
    public required double TradeRate { get; init; }

    /// <summary>The trade rate against its own recent median: active, thin or unknown (REQUIREMENTS.md FR-83).</summary>
    public required TapeReading Tape { get; init; }

    public required long SessionVolume { get; init; }

    public required IReadOnlyList<LiquidityWall> Walls { get; init; }

    /// <summary>The last five reported walls that ended in the last 15 minutes, newest first (REQUIREMENTS.md FR-78).</summary>
    public IReadOnlyList<EndedWall> EndedWalls { get; init; } = [];
}
