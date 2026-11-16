using System.Text.Json.Serialization;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Market;

/// <summary>A side of the book. A trade's aggressor is the side that crossed the spread.</summary>
public enum BookSide
{
    Bid,
    Ask,
}

/// <summary>Where the events come from: shown on the status chip so replayed or simulated data is never labelled live (REQUIREMENTS.md FR-4).</summary>
public enum FeedProvenance
{
    Live,
    Replay,
    Simulated,
}

/// <summary>One price level of a baseline snapshot.</summary>
public readonly record struct BookLevel(long PriceTicks, long Quantity);

/// <summary>
/// A normalized market event (INTERFACES.md Interface A, A.5): source time, received time, the epoch of the
/// upstream connection and a local sequence number travel with every event (REQUIREMENTS.md NFR-5).
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(DepthSnapshotEvent), "snapshot")]
[JsonDerivedType(typeof(DepthUpdateEvent), "depth")]
[JsonDerivedType(typeof(BookResetEvent), "reset")]
[JsonDerivedType(typeof(TradeEvent), "trade")]
[JsonDerivedType(typeof(FeedStatusEvent), "status")]
[JsonDerivedType(typeof(QuoteEvent), "quote")]
[JsonDerivedType(typeof(TradeGapEvent), "gap")]
public abstract record MarketEvent
{
    public required InstrumentRoot Root { get; init; }

    public required string ContractId { get; init; }

    /// <summary>Unix milliseconds (UTC) stamped by the source.</summary>
    public required long SourceTimeMs { get; init; }

    /// <summary>Unix milliseconds (UTC) when the server received the event.</summary>
    public required long ReceivedTimeMs { get; init; }

    /// <summary>One unbroken upstream connection (REQUIREMENTS.md §1 terminology).</summary>
    public required long Epoch { get; init; }

    public required long Sequence { get; init; }
}

/// <summary>A complete baseline of the top <see cref="LevelsPerSide"/> levels on each side: the only event that makes a book known (REQUIREMENTS.md FR-11).</summary>
public sealed record DepthSnapshotEvent : MarketEvent
{
    public required IReadOnlyList<BookLevel> Bids { get; init; }

    public required IReadOnlyList<BookLevel> Asks { get; init; }

    public required int LevelsPerSide { get; init; }

    /// <summary>True only for the book built after a subscribe, not a gateway reset or an ingest overflow (D-32).</summary>
    public bool Resubscribe { get; init; }

    /// <summary>Latest sane gateway timestamp when the book was built. Used only to end a dropped-trade gap (D-32).</summary>
    public long? GatewayTimeMs { get; init; }
}

/// <summary>The absolute resting quantity at one price; zero removes the level.</summary>
public sealed record DepthUpdateEvent : MarketEvent
{
    public required BookSide Side { get; init; }

    public required long PriceTicks { get; init; }

    public required long Quantity { get; init; }
}

/// <summary>The upstream reset its book: every level is unknown until the next snapshot (REQUIREMENTS.md FR-11).</summary>
public sealed record BookResetEvent : MarketEvent
{
    /// <summary>The feed's reset after it subscribes depth. Only the snapshot that follows this one can close a gap.</summary>
    public const string SubscribedReason = "subscribed";

    public required string Reason { get; init; }
}

/// <summary>An execution. <see cref="Aggressor"/> is <see cref="BookSide.Bid"/> for a buyer lifting the offer.</summary>
public sealed record TradeEvent : MarketEvent
{
    public required long PriceTicks { get; init; }

    public required long Quantity { get; init; }

    public required BookSide Aggressor { get; init; }

    /// <summary>Identifier used to drop duplicates (REQUIREMENTS.md FR-14).</summary>
    public required string TradeId { get; init; }
}

/// <summary>
/// The upstream connection changed state, or depth for this product was switched on or off. A product whose depth
/// is off (not watched; REQUIREMENTS.md FR-54) streams trades and quotes only: its book is unknown, which is expected and is
/// not reported as RECOVERING.
/// </summary>
public sealed record FeedStatusEvent : MarketEvent
{
    public required bool Connected { get; init; }

    public required FeedProvenance Provenance { get; init; }

    /// <summary>Whether depth is being received for this product; true when absent (replay files before FR-54).</summary>
    public bool DepthSubscribed { get; init; } = true;

    /// <summary>Latest sane gateway timestamp. Used only to end a dropped-trade gap; the event's own time stays local (D-32).</summary>
    public long? GatewayTimeMs { get; init; }
}

/// <summary>
/// The ingest buffer dropped live trades for this contract. The engine marks the hole. A minute-bar source
/// may fill the closed minutes off the reader; the contract stays approximate, never LIVE (D-32, D-33).
/// Not a wire message to the browser.
/// </summary>
public sealed record TradeGapEvent : MarketEvent
{
    /// <summary>Source time of the first trade that did not fit. History is read from here, with a margin for the bar that contains it.</summary>
    public required long GapStartMs { get; init; }

    /// <summary>Source time of the latest trade that did not fit. Equals <see cref="GapStartMs"/> when only one was dropped.</summary>
    public long GapThroughMs { get; init; }

    public required FeedProvenance Provenance { get; init; }

    public bool DepthSubscribed { get; init; } = true;
}

/// <summary>
/// The best bid and offer prices from the quote stream (no sizes): the top of book of a product streamed without
/// depth (REQUIREMENTS.md FR-54). Never makes a book known and never moves a heatmap cell.
/// </summary>
public sealed record QuoteEvent : MarketEvent
{
    public long? BidTicks { get; init; }

    public long? AskTicks { get; init; }
}
