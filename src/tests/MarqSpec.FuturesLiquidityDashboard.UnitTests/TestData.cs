using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests;

/// <summary>
/// Synthetic builders shared by the Core unit tests. Every time is relative to one fixed epoch, a Tuesday during the
/// regular session, and every price is an invented tick key: nothing here is real market data.
/// </summary>
internal static class TestData
{
    /// <summary>Tuesday 2026-11-10 14:00 UTC (08:00 CST): inside the 2026-11-10 Globex session.</summary>
    public static readonly DateTimeOffset Epoch = new(2026, 11, 10, 14, 0, 0, TimeSpan.Zero);

    /// <summary>The 2026-11-10 session's open: Monday 2026-11-09 17:00 CST, 23:00 UTC.</summary>
    public static readonly DateTimeOffset SessionOpen = new(2026, 11, 9, 23, 0, 0, TimeSpan.Zero);

    public const string EsContract = "MESZ26";

    /// <summary>A synthetic ES price key (6000.00 at a 0.25 tick).</summary>
    public const long EsBase = 24_000;

    private static long _sequence;

    public static long EpochMs { get; } = Epoch.ToUnixTimeMilliseconds();

    public static long SessionOpenMs { get; } = SessionOpen.ToUnixTimeMilliseconds();

    /// <summary>A fixed UTC−6 zone with no daylight saving, so session boundaries never depend on the host's tzdata.</summary>
    public static TimeZoneInfo FixedCentral { get; } =
        TimeZoneInfo.CreateCustomTimeZone("Test/CST", TimeSpan.FromHours(-6), "Test CST", "Test CST");

    public static ExchangeCalendar Calendar() => new(FixedCentral);

    public static TradeEvent Trade(
        long timeMs,
        long priceTicks,
        long quantity,
        BookSide aggressor,
        string tradeId,
        string contractId = EsContract,
        InstrumentRoot? root = null) => new()
        {
            Root = root ?? InstrumentRoot.MES,
            ContractId = contractId,
            SourceTimeMs = timeMs,
            ReceivedTimeMs = timeMs,
            Epoch = 1,
            Sequence = Interlocked.Increment(ref _sequence),
            PriceTicks = priceTicks,
            Quantity = quantity,
            Aggressor = aggressor,
            TradeId = tradeId,
        };

    public static DepthUpdateEvent Depth(long timeMs, BookSide side, long priceTicks, long quantity) => new()
    {
        Root = InstrumentRoot.MES,
        ContractId = EsContract,
        SourceTimeMs = timeMs,
        ReceivedTimeMs = timeMs,
        Epoch = 1,
        Sequence = Interlocked.Increment(ref _sequence),
        Side = side,
        PriceTicks = priceTicks,
        Quantity = quantity,
    };

    /// <summary>A snapshot of five bids below and five asks from <paramref name="bestAsk"/>, <paramref name="size"/> each.</summary>
    public static DepthSnapshotEvent Snapshot(long timeMs, long bestAsk = EsBase, long size = 10, int levelsPerSide = 10) => new()
    {
        Root = InstrumentRoot.MES,
        ContractId = EsContract,
        SourceTimeMs = timeMs,
        ReceivedTimeMs = timeMs,
        Epoch = 1,
        Sequence = Interlocked.Increment(ref _sequence),
        Bids = [.. Enumerable.Range(1, 5).Select(i => new BookLevel(bestAsk - i, size))],
        Asks = [.. Enumerable.Range(0, 5).Select(i => new BookLevel(bestAsk + i, size))],
        LevelsPerSide = levelsPerSide,
    };

    public static DepthSnapshotEvent Snapshot(long timeMs, IReadOnlyList<BookLevel> bids, IReadOnlyList<BookLevel> asks, int levelsPerSide) => new()
    {
        Root = InstrumentRoot.MES,
        ContractId = EsContract,
        SourceTimeMs = timeMs,
        ReceivedTimeMs = timeMs,
        Epoch = 1,
        Sequence = Interlocked.Increment(ref _sequence),
        Bids = bids,
        Asks = asks,
        LevelsPerSide = levelsPerSide,
    };

    public static BookResetEvent Reset(long timeMs) => new()
    {
        Root = InstrumentRoot.MES,
        ContractId = EsContract,
        SourceTimeMs = timeMs,
        ReceivedTimeMs = timeMs,
        Epoch = 1,
        Sequence = Interlocked.Increment(ref _sequence),
        Reason = "synthetic reset",
    };

    public static FeedStatusEvent Status(long timeMs, bool connected, FeedProvenance provenance = FeedProvenance.Simulated) => new()
    {
        Root = InstrumentRoot.MES,
        ContractId = EsContract,
        SourceTimeMs = timeMs,
        ReceivedTimeMs = timeMs,
        Epoch = 1,
        Sequence = Interlocked.Increment(ref _sequence),
        Connected = connected,
        Provenance = provenance,
    };

    /// <summary>A known book: five bids below and five asks from <paramref name="bestAsk"/>, <paramref name="size"/> each.</summary>
    public static OrderBook Book(long bestAsk = 1000, long size = 10, int levelsPerSide = 10)
    {
        var book = new OrderBook();
        book.ApplySnapshot(Snapshot(EpochMs, bestAsk, size, levelsPerSide));
        return book;
    }

    /// <summary>
    /// A closed footprint bar with the given OHLC and net delta: one lot each at open, high, low and close (net zero),
    /// then |<paramref name="delta"/>| lots at the close on the side that gives the delta.
    /// </summary>
    public static FootprintBar Bar(long startMs, long open, long high, long low, long close, long delta, long durationMs = 60_000)
    {
        var bar = new FootprintBar(startMs, durationMs);
        bar.Add(open, 1, buyerAggressor: true);
        bar.Add(high, 1, buyerAggressor: false);
        bar.Add(low, 1, buyerAggressor: true);
        bar.Add(close, 1, buyerAggressor: false);
        if (delta != 0)
        {
            bar.Add(close, Math.Abs(delta), buyerAggressor: delta > 0);
        }

        return bar;
    }

    /// <summary>A footprint bar from explicit cells: (price, bid volume, ask volume), lowest price first.</summary>
    public static FootprintBar Cells(long startMs, params (long Price, long Bid, long Ask)[] cells)
    {
        var bar = new FootprintBar(startMs, 60_000);
        foreach (var (price, bid, ask) in cells)
        {
            bar.Add(price, bid, buyerAggressor: false);
            bar.Add(price, ask, buyerAggressor: true);
        }

        return bar;
    }
}
