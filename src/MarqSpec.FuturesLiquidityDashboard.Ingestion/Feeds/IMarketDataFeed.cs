using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;

/// <summary>
/// One upstream market-data session for every enabled instrument (ARCHITECTURE.md D-11), producing normalized
/// events (INTERFACES.md Interface A, A.5). Implementations: synthetic (the default), replay, and the
/// ProjectX adapter gated by Stage 0 (ARCHITECTURE.md D-1, D-15).
/// </summary>
public interface IMarketDataFeed
{
    string Name { get; }

    FeedProvenance Provenance { get; }

    IAsyncEnumerable<MarketEvent> StreamAsync(IReadOnlyList<InstrumentSpec> instruments, CancellationToken cancellationToken);
}

/// <summary>Historical executions for indicator, VWAP and profile warmup only, never depth (INTERFACES.md Interface B).</summary>
public interface IHistoricalTradeSource
{
    Task<IReadOnlyList<TradeEvent>> GetTradesAsync(InstrumentSpec instrument, long fromMs, long toMs, CancellationToken cancellationToken);
}

/// <summary>
/// Closed one-minute bars for approximate gap repair. The current partial minute is never returned.
/// A non-empty result is not proof the gap's last minute has closed (ARCHITECTURE.md D-33).
/// </summary>
public interface IMinuteBarSource
{
    Task<IReadOnlyList<HistoricalMinuteBar>> GetClosedMinuteBarsAsync(
        InstrumentSpec instrument,
        long fromMs,
        long toMs,
        CancellationToken cancellationToken);
}
