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

/// <summary>
/// The liquidity metrics of the dashboard, each with a fixed definition (documented in REQUIREMENTS.md FR-36–FR-40):
/// spread and microprice at the top of book, depth and imbalance at 1/5/10 levels, liquidity flow (added, pulled,
/// filled) over 10 s and 60 s, cumulative delta, trade rate and persistent walls.
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

    public required long SessionVolume { get; init; }

    public required IReadOnlyList<LiquidityWall> Walls { get; init; }
}
