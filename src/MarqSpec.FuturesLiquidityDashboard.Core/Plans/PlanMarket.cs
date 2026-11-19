using MarqSpec.FuturesLiquidityDashboard.Core.Heatmap;
using MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Regime;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Plans;

/// <summary>
/// One covered price of the current book: the resting quantity on each side, or null where that side is unknown
/// (REQUIREMENTS.md FR-11). Zero means known to be empty.
/// </summary>
public sealed record PlanBookCell(long PriceTicks, long? Bid, long? Ask);

/// <summary>
/// The book as the plan metrics read it. <see cref="Cells"/> holds every price from <see cref="CoveredLow"/> to
/// <see cref="CoveredHigh"/>; a price outside them is unknown, never zero.
/// </summary>
public sealed record PlanBook(bool Known, long? BestBid, long? BestAsk, long? CoveredLow, long? CoveredHigh, IReadOnlyList<PlanBookCell> Cells)
{
    public static PlanBook Unknown { get; } = new(false, null, null, null, null, []);

    /// <summary>The resting quantity on <paramref name="side"/> at <paramref name="priceTicks"/>, or null when unknown.</summary>
    public long? QuantityAt(BookSide side, long priceTicks)
    {
        if (!Known || CoveredLow is not { } low || CoveredHigh is not { } high || priceTicks < low || priceTicks > high)
        {
            return null;
        }

        foreach (var cell in Cells)
        {
            if (cell.PriceTicks == priceTicks)
            {
                return side == BookSide.Bid ? cell.Bid : cell.Ask;
            }
        }

        return null;
    }
}

/// <summary>A closed one-minute bar. <see cref="Missing"/> marks a minute inside a dropped-trade hole (D-32).</summary>
public sealed record PlanMinute(long StartMs, long? High, long? Low, bool Missing);

/// <summary>A named price the metrics measure against: profile, VWAP, prior-session and overlay levels.</summary>
/// <param name="Kind"><c>profile</c>, <c>vwap</c>, <c>prior-session</c> or <c>overlay</c>.</param>
public sealed record PlanLevel(string Kind, string Name, long PriceTicks);

/// <summary>What the plan's inputs cover, so a partial history is never read as a complete one (REQUIREMENTS.md FR-4, FR-25).</summary>
public sealed record PlanCoverage
{
    /// <summary>The session profile is complete only from this time; null when it covers the whole session.</summary>
    public long? ProfilePartialSinceMs { get; init; }

    /// <summary>The session VWAP began after the session did.</summary>
    public bool VwapPartial { get; init; }

    /// <summary>The session's flow is incomplete: CVD is unknown after a dropped trade, the session profile is partial since a time, or it holds a missing or approximate range.</summary>
    public bool FlowPartial { get; init; }

    /// <summary>Trades have been dropped since this time and not yet recovered (D-32).</summary>
    public long? MissingSinceMs { get; init; }
}

/// <summary>
/// Everything the plan metrics read about one instrument at one instant (REQUIREMENTS.md FR-73). The engine gathers it under
/// its lock; <see cref="PlanMetricsCalculator"/> computes from it alone, so the metrics are testable without a feed.
/// Prices are integer ticks; times are Unix milliseconds.
/// </summary>
public sealed record PlanMarket
{
    public required string Root { get; init; }

    public required string ContractId { get; init; }

    public required long AsOfMs { get; init; }

    public required string StatusCode { get; init; }

    public long? LastTicks { get; init; }

    /// <summary>The latest closed one-minute ATR, in ticks (REQUIREMENTS.md FR-21); null until it is ready.</summary>
    public double? AtrTicks { get; init; }

    public required PlanBook Book { get; init; }

    /// <summary>The heatmap slice length; the ten-minute window ends at the last slice boundary at or before <see cref="AsOfMs"/>.</summary>
    public int SliceMs { get; init; } = 1_000;

    /// <summary>Closed heatmap slices, oldest first; the metrics read the last ten minutes of them (REQUIREMENTS.md FR-12).</summary>
    public required IReadOnlyList<HeatmapColumn> RecentHeat { get; init; }

    /// <summary>Closed one-minute bars, oldest first.</summary>
    public required IReadOnlyList<PlanMinute> Minutes { get; init; }

    public required IReadOnlyList<LiquidityWall> Walls { get; init; }

    public required IReadOnlyList<IcebergReading> Icebergs { get; init; }

    public required IReadOnlyList<OrderFlowSignal> Signals { get; init; }

    public required IReadOnlyList<ImbalanceZone> Zones { get; init; }

    public required IReadOnlyList<UnfinishedAuction> UnfinishedAuctions { get; init; }

    public required IReadOnlyList<PlanLevel> Levels { get; init; }

    /// <summary>Ask minus bid volume at each price over every print of this session, kept per price and reset at the
    /// session open; not read from the retained footprints (REQUIREMENTS.md FR-73).</summary>
    public required IReadOnlyDictionary<long, long> SessionDeltaByPrice { get; init; }

    public required IReadOnlyList<RegimeDto> Regimes { get; init; }

    public required PlanCoverage Coverage { get; init; }
}
