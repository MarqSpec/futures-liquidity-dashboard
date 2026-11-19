using MarqSpec.FuturesLiquidityDashboard.Core.Regime;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Plans;

// The named, versioned plan metrics of REQUIREMENTS.md FR-73 (ARCHITECTURE.md D-60). Every name here is stable: a change to a
// definition raises PlanMetrics.CurrentDefinitionsVersion. A null value is unknown, never zero (REQUIREMENTS.md FR-11), and
// says why in the matching *Reason field where one exists.

/// <summary>Why a value is unknown.</summary>
public static class UnknownReasons
{
    public const string BookUnknown = "book-unknown";
    public const string OutsideCoveredDepth = "outside-covered-depth";
    public const string LevelUnknown = "level-unknown";
    public const string NoLastPrice = "no-last-price";
    public const string AtrUnknown = "atr-unknown";
    public const string NoReferencePrice = "no-reference-price";
    public const string NoRisk = "no-risk";
    public const string NoKnownTime = "no-known-time";
    public const string SideEmpty = "side-empty";
}

/// <summary>The size resting on the side a leg would join, now and on average over the last ten minutes (FR-12).</summary>
/// <param name="Side"><c>bid</c> or <c>ask</c>.</param>
/// <param name="Now">The resting quantity at the leg's price now; null when unknown.</param>
/// <param name="Mean10m">Time-weighted mean over the known milliseconds of the last 600 closed one-second slices, the window
/// ending at the last slice boundary at or before the read; null when none was known.</param>
/// <param name="Coverage10m">Known milliseconds over 600,000, 0–1.</param>
/// <param name="Partial">True when <paramref name="Coverage10m"/> is below 1.</param>
public sealed record RestingSize(string Side, long? Now, string? NowReason, double? Mean10m, string? Mean10mReason, double Coverage10m, bool Partial);

/// <summary>Of the last <see cref="Bars"/> one-minute slots, the share whose bar traded strictly through the price.</summary>
/// <param name="Direction"><c>below</c>: a bar counts when its low is under the price; <c>above</c>: when its high is over it.</param>
/// <param name="Known">Slots with a closed, not-missing bar. Only these are counted.</param>
/// <param name="Through">Known slots that traded strictly through the price.</param>
/// <param name="Share"><paramref name="Through"/> over <paramref name="Known"/>; null when no slot is known.</param>
/// <param name="Coverage"><paramref name="Known"/> over <paramref name="Bars"/>, 0–1.</param>
public sealed record ThroughFrequency(int Bars, string Direction, int Known, int Through, double? Share, double Coverage, bool Partial);

/// <summary>Resting or detected liquidity between the last price and a leg (FR-40, UC-15).</summary>
/// <param name="Kind"><c>wall</c>, <c>iceberg</c>, <c>spoof</c> or <c>sweep</c>.</param>
/// <param name="Side"><c>bid</c> or <c>ask</c> for a wall or an iceberg; null for a signal.</param>
/// <param name="Size">A wall's resting quantity or an iceberg's traded quantity; null for a signal, which records none.</param>
/// <param name="AgeMs">Since a wall last reached its threshold, an iceberg was first seen, or a signal fired.</param>
public sealed record InTheWayItem(string Kind, string? Side, long PriceTicks, long PriceHighTicks, long? Size, long AgeMs);

/// <summary>Liquidity between the last price and the leg. <see cref="Items"/> is null without a last price.</summary>
/// <param name="WallsKnown">False while the book is unknown: no wall is reported then, which is not "no wall".</param>
public sealed record InTheWay(bool WallsKnown, IReadOnlyList<InTheWayItem>? Items, string? ItemsReason);

/// <summary>A named level near a leg; <see cref="DistanceTicks"/> is the level's price minus the leg's.</summary>
public sealed record NearLevel(string Kind, string Name, long PriceTicks, long DistanceTicks);

/// <summary>A footprint signal near a leg (UC-14). <c>Kind</c> is <c>trapped-traders</c>, <c>cvd-divergence</c> or
/// <c>delta-exhaustion</c>; <c>Bias</c> is <c>bullish</c>, <c>bearish</c> or <c>neutral</c>.</summary>
public sealed record NearSignal(string Kind, string Bias, long PriceTicks, long PriceHighTicks, long AgeMs);

/// <summary>A stacked-imbalance zone near a leg (FR-42). <c>Bias</c> is <c>bullish</c> or <c>bearish</c>.</summary>
public sealed record NearZone(string Bias, long LowTicks, long HighTicks);

/// <summary>An unfinished auction near a leg (FR-43).</summary>
public sealed record NearAuction(long PriceTicks, bool AtHigh, long BarStartMs);

/// <summary>Order-flow context at and within two ATR of a leg. The near lists are null while ATR is unknown.</summary>
/// <param name="SessionDeltaAtPrice">Ask minus bid volume at the leg's price over every print of this session, kept per
/// price by the engine and reset at the session open, not read from the retained footprints; null when nothing traded there.</param>
/// <param name="Partial">True when CVD is unknown after a dropped trade, the session profile is partial since a time, or it holds a missing or approximate range.</param>
public sealed record FlowContext(
    long? SessionDeltaAtPrice,
    bool Partial,
    IReadOnlyList<NearZone>? Zones,
    IReadOnlyList<NearAuction>? UnfinishedAuctions,
    IReadOnlyList<NearSignal>? Signals,
    string? NearReason);

/// <summary>The metrics of one leg: the entry, the stop or one target.</summary>
/// <param name="Leg"><c>entry</c>, <c>stop</c> or <c>target</c>.</param>
/// <param name="Index">The target's position in the plan, from 0; null for the entry and the stop.</param>
/// <param name="PriceTicks">The leg's price; a market entry drawn at no price uses the last price, and is null without one.</param>
/// <param name="DistanceTicks">Leg price minus the last price.</param>
/// <param name="DistanceAtr"><paramref name="DistanceTicks"/> over the one-minute ATR.</param>
/// <param name="RestingAhead">A limit entry or a target only; null for the stop and a market entry.</param>
public sealed record LegMetrics(
    string Leg,
    int? Index,
    long? PriceTicks,
    long? DistanceTicks,
    double? DistanceAtr,
    string? DistanceReason,
    RestingSize? RestingAhead,
    IReadOnlyList<ThroughFrequency> ThroughFrequency,
    long? LastReachedMs,
    InTheWay InTheWay,
    IReadOnlyList<NearLevel>? KeyLevels,
    string? KeyLevelsReason,
    FlowContext Flow);

/// <summary>Reward over risk for one target, from the entry (or the last price for an unpriced market entry).</summary>
public sealed record RewardRisk(int Index, long TargetTicks, double? Ratio, string? Reason);

/// <summary>A level or wall the stop sits just inside: on the entry's side of it, 1 or 2 ticks away.</summary>
public sealed record StopNear(string Kind, string Name, long PriceTicks, long DistanceTicks);

/// <summary>Whether the stop sits within two ticks on the wrong side of a key level or a wall.</summary>
public sealed record StopPlacement(bool JustInside, IReadOnlyList<StopNear> Near, bool WallsKnown);

/// <summary>The expected cost beyond the touch of a market entry filled by walking the current book (FR-37).</summary>
/// <param name="TouchTicks">The best ask for a long, the best bid for a short.</param>
/// <param name="AverageTicks">The quantity-weighted average price of the walk.</param>
/// <param name="SlippageTicks">How far <paramref name="AverageTicks"/> is past <paramref name="TouchTicks"/>, never negative.</param>
/// <param name="WorstTicks">The last price level the walk reached.</param>
public sealed record MarketSlippage(
    long? TouchTicks,
    double? AverageTicks,
    double? SlippageTicks,
    long? WorstTicks,
    int LevelsWalked,
    string? Reason);

/// <summary>The plan metrics for one instrument at one instant (REQUIREMENTS.md FR-73).</summary>
public sealed record PlanMetrics
{
    public const int CurrentDefinitionsVersion = 1;

    public int DefinitionsVersion { get; init; } = CurrentDefinitionsVersion;

    public required string Instrument { get; init; }

    public required string ContractId { get; init; }

    public required long AsOfMs { get; init; }

    public required string StatusCode { get; init; }

    public long? LastTicks { get; init; }

    public double? AtrTicks { get; init; }

    public required IReadOnlyList<LegMetrics> Legs { get; init; }

    public required IReadOnlyList<RewardRisk> RewardRisk { get; init; }

    /// <summary>The distance from the entry to the stop, over the one-minute ATR.</summary>
    public double? StopAtr { get; init; }

    public string? StopAtrReason { get; init; }

    public required StopPlacement StopPlacement { get; init; }

    /// <summary>Null unless the entry is a market entry.</summary>
    public MarketSlippage? MarketSlippage { get; init; }

    /// <summary>The 5-minute and 15-minute regimes (UC-19).</summary>
    public required IReadOnlyList<RegimeDto> Regimes { get; init; }

    public required PlanCoverage Coverage { get; init; }
}
