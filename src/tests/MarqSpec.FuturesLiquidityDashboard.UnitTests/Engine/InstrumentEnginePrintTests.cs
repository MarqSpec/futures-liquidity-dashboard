using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Levels;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Engine;

// reference: REQUIREMENTS.md FR-59, FR-61, FR-63, NFR-4; ARCHITECTURE.md D-34, D-35
public sealed class InstrumentEnginePrintTests
{
    private const long Px = TestData.EsBase;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Snapshot_ShouldDropTheOldestPrint_WhenTheBufferOverflows()
    {
        var engine = Engine(printCapacity: 2);
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Trade(T0 + 1, Px, 1, BookSide.Bid, "a"));
        engine.Apply(TestData.Trade(T0 + 2, Px, 2, BookSide.Ask, "b"));
        engine.Apply(TestData.Trade(T0 + 3, Px, 3, BookSide.Bid, "c"));

        var prints = engine.Snapshot(60, null).Prints;

        prints.Select(print => print.Quantity).Should().Equal(2L, 3L);
        prints.Select(print => print.Sequence).Should().Equal(2L, 3L);
    }

    [Fact]
    public void Publish_ShouldSendOnlyPrintsNewerThanTheWatermark_WhenCalledAgain()
    {
        var engine = Engine();
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Trade(T0 + 1, Px, 1, BookSide.Bid, "a"));
        engine.Apply(TestData.Trade(T0 + 2, Px, 4, BookSide.Ask, "b"));

        var first = engine.Publish(null);
        var second = engine.Publish(null);
        engine.Apply(TestData.Trade(T0 + 3, Px, 9, BookSide.Bid, "c"));
        var third = engine.Publish(null);

        first.Prints.Select(print => print.Sequence).Should().Equal(1L, 2L);
        second.Prints.Should().BeEmpty();
        third.Prints.Should().ContainSingle().Which.Should().BeEquivalentTo(new { Sequence = 3L, Quantity = 9L, Aggressor = "Bid" });
        engine.Snapshot(60, null).Prints.Should().HaveCount(3);
    }

    [Fact]
    public void Publish_ShouldNotReplayThePreviousEpoch_WhenTheEpochChanges()
    {
        var engine = Engine();
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Trade(T0 + 1, Px, 1, BookSide.Bid, "old"));
        engine.Apply(TestData.Status(T0 + 2, connected: true) with { Epoch = 2 });
        engine.Apply(TestData.Trade(T0 + 3, Px, 8, BookSide.Ask, "new"));

        var delta = engine.Publish(null);

        delta.Prints.Should().ContainSingle().Which.Quantity.Should().Be(8);
        engine.Snapshot(60, null).Prints.Select(print => print.Quantity).Should().Equal(8L);
    }

    [Fact]
    public void Snapshot_ShouldOmitWarmupPrints_WhenHistoryHasNoAggressorTape()
    {
        var engine = Engine();
        engine.LoadHistory([TestData.Trade(T0, Px, 4, BookSide.Bid, "history")], T0 + 60_000);
        engine.Apply(TestData.Status(T0 + 60_000, connected: true));
        engine.Apply(TestData.Trade(T0, Px + 1, 9, BookSide.Ask, "at-watermark"));
        engine.Apply(TestData.Trade(T0 + 61_000, Px + 2, 3, BookSide.Bid, "live"));

        var snapshot = engine.Snapshot(60, null);

        snapshot.HistoryWatermarkMs.Should().Be(T0);
        snapshot.Prints.Should().ContainSingle().Which.Should().BeEquivalentTo(new { Quantity = 3L, Aggressor = "Bid", SourceTimeMs = T0 + 61_000 });
    }

    [Fact]
    public void KeyLevels_ShouldNameRthAsiaDailyOpenAndFourHourMid_WhenTheMinutesCoverThoseWindows()
    {
        var engine = Engine();
        engine.Apply(Trade(Utc(2026, 11, 9, 14, 30), 90, "rth-open"));
        engine.Apply(Trade(Utc(2026, 11, 9, 21, 14), 110, "rth-close"));
        engine.Apply(Trade(Utc(2026, 11, 9, 23, 0), 70, "asia-open"));
        engine.Apply(Trade(Utc(2026, 11, 10, 7, 59), 80, "asia-close"));
        engine.Apply(Trade(Utc(2026, 11, 10, 10, 0), 50, "before-rth"));
        engine.Apply(Trade(Utc(2026, 11, 10, 14, 30), 95, "daily-open"));
        engine.Apply(Trade(Utc(2026, 11, 10, 14, 40), 105, "four-hour"));

        var levels = engine.Snapshot(60, null).OrderFlow.KeyLevels;

        levels.Should().Contain(level => level.Name == "VWAP");
        Named(levels, RipsLevelNames.Pdh).PriceTicks.Should().Be(110);
        Named(levels, RipsLevelNames.Pdl).PriceTicks.Should().Be(90);
        Named(levels, RipsLevelNames.Pdh).SessionId.Should().Be("2026-11-09");
        Named(levels, RipsLevelNames.AsiaHigh).PriceTicks.Should().Be(80);
        Named(levels, RipsLevelNames.AsiaLow).PriceTicks.Should().Be(70);
        Named(levels, RipsLevelNames.DailyOpen).PriceTicks.Should().Be(95);
        Named(levels, RipsLevelNames.FourHourMid).PriceTicks.Should().Be(100);
        levels.Should().NotContain(level => level.Name == RipsLevelNames.PriorWeekHigh);
        engine.Snapshot(60, null).LevelTouches.Should().Contain(level => level.Name == RipsLevelNames.Pdh && !level.IsThirdTouch);
    }

    [Fact]
    public void Liquidity_ShouldMarkTheQuoteStale_WhenTheTopOfBookIsOlderThanTheStaleWindow()
    {
        var engine = Engine();
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));
        engine.Tick(T0 + 10_000);

        var stale = engine.Snapshot(60, null).Liquidity;
        stale.QuoteStale.Should().BeTrue();
        stale.BestBid.Should().NotBeNull();

        engine.Apply(new QuoteEvent
        {
            Root = InstrumentRoot.MES,
            ContractId = TestData.EsContract,
            SourceTimeMs = T0 + 10_000,
            ReceivedTimeMs = T0 + 10_000,
            Epoch = 1,
            Sequence = 1,
            BidTicks = Px - 2,
            AskTicks = Px + 2,
        });
        engine.Tick(T0 + 10_000);

        var fresh = engine.Snapshot(60, null).Liquidity;
        fresh.QuoteStale.Should().BeFalse();
        fresh.BestBid.Should().Be(Px - 1);
        fresh.QuoteTimeMs.Should().Be(T0 + 10_000);
    }

    [Fact]
    public void KeyLevels_ShouldKeepPdhAndThePriorWeek_WhenMondayRthStartsAfterTheMinutesWereTrimmed()
    {
        var engine = Engine();
        engine.Apply(Trade(Utc(2026, 11, 8, 23, 0), 200, "week-open"));
        engine.Apply(Trade(Utc(2026, 11, 13, 14, 30), 220, "friday-open"));
        engine.Apply(Trade(Utc(2026, 11, 13, 21, 14), 250, "friday-close"));
        engine.Apply(Trade(Utc(2026, 11, 13, 21, 59), 260, "week-close"));
        engine.Tick(Utc(2026, 11, 16, 15, 0).ToUnixTimeMilliseconds());

        var levels = engine.Snapshot(60, null).OrderFlow.KeyLevels;

        Named(levels, RipsLevelNames.Pdh).PriceTicks.Should().Be(250);
        Named(levels, RipsLevelNames.Pdl).PriceTicks.Should().Be(220);
        Named(levels, RipsLevelNames.Pdh).SessionId.Should().Be("2026-11-13");
        Named(levels, RipsLevelNames.PriorWeekHigh).PriceTicks.Should().Be(260);
        Named(levels, RipsLevelNames.PriorWeekMid).PriceTicks.Should().Be(230);
        engine.Snapshot(60, null).MinuteBars.Should().NotContain(bar => bar.T == Utc(2026, 11, 8, 23, 0).ToUnixTimeMilliseconds());
    }

    [Fact]
    public void KeyLevels_ShouldOmitPdh_WhenThePriorRthWasOnlySeenFromMidSession()
    {
        var engine = Engine();
        engine.Apply(Trade(Utc(2026, 11, 13, 18, 0), 240, "friday-mid"));
        engine.Apply(Trade(Utc(2026, 11, 13, 21, 14), 250, "friday-close"));
        engine.Tick(Utc(2026, 11, 16, 15, 0).ToUnixTimeMilliseconds());

        var levels = engine.Snapshot(60, null).OrderFlow.KeyLevels;

        levels.Should().NotContain(level => level.Name == RipsLevelNames.Pdh);
        levels.Should().NotContain(level => level.Name == RipsLevelNames.Pdl);
    }

    [Fact]
    public void KeyLevels_ShouldOmitThePriorWeek_WhenTheWeekOpenWasNeverSeen()
    {
        var engine = Engine();
        engine.Apply(Trade(Utc(2026, 11, 13, 21, 59), 260, "week-close"));
        engine.Tick(Utc(2026, 11, 16, 15, 0).ToUnixTimeMilliseconds());

        engine.Snapshot(60, null).OrderFlow.KeyLevels.Should().NotContain(level =>
            level.Name == RipsLevelNames.PriorWeekHigh || level.Name == RipsLevelNames.PriorWeekMid);
    }

    [Fact]
    public void Liquidity_ShouldUseReceiveTimeForStale_WhenTheExchangeTimeIsSkewed()
    {
        var engine = Engine();
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(Quote(sourceMs: T0 - 30_000, receivedMs: T0, bid: Px - 2, ask: Px + 2));
        engine.Tick(T0 + 1_000);

        var fresh = engine.Snapshot(60, null).Liquidity;
        fresh.QuoteTimeMs.Should().Be(T0 - 30_000);
        fresh.QuoteStale.Should().BeFalse();
        fresh.BestBid.Should().Be(Px - 2);

        engine.Apply(Quote(sourceMs: T0 + 10_000, receivedMs: T0, bid: Px - 3, ask: Px + 3));
        engine.Tick(T0 + 10_000);

        engine.Snapshot(60, null).Liquidity.QuoteStale.Should().BeTrue();
    }

    [Fact]
    public void Liquidity_ShouldMarkTheQuoteStale_WhenTheFeedDisconnects()
    {
        var engine = Engine();
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(Quote(sourceMs: T0, receivedMs: T0, bid: Px - 2, ask: Px + 2));
        engine.Apply(TestData.Status(T0 + 500, connected: false));
        engine.Tick(T0 + 500);

        engine.Snapshot(60, null).Liquidity.QuoteStale.Should().BeTrue();
    }

    private static QuoteEvent Quote(long sourceMs, long receivedMs, long bid, long ask) => new()
    {
        Root = InstrumentRoot.MES,
        ContractId = TestData.EsContract,
        SourceTimeMs = sourceMs,
        ReceivedTimeMs = receivedMs,
        Epoch = 1,
        Sequence = 1,
        BidTicks = bid,
        AskTicks = ask,
    };

    private static Core.OrderFlow.KeyLevel Named(IReadOnlyList<Core.OrderFlow.KeyLevel> levels, string name) =>
        levels.Should().ContainSingle(level => level.Name == name).Subject;

    private static InstrumentEngine Engine(int printCapacity = 32) =>
        new(InstrumentCatalog.MES, EngineOptions.Default with { PrintCapacity = printCapacity }, TestData.Calendar());

    private static TradeEvent Trade(DateTimeOffset time, long price, string id) =>
        TestData.Trade(time.ToUnixTimeMilliseconds(), price, 1, BookSide.Bid, id);

    private static DateTimeOffset Utc(int year, int month, int day, int hour, int minute) =>
        new(year, month, day, hour, minute, 0, TimeSpan.Zero);
}
