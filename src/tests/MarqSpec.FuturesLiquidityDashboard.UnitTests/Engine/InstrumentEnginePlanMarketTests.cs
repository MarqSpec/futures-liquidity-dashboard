using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Engine;

// reference: REQUIREMENTS.md FR-73, FR-11; ARCHITECTURE.md D-60 (the engine gathers the plan metrics' inputs under its lock)
public sealed class InstrumentEnginePlanMarketTests
{
    private static readonly long T0 = TestData.EpochMs;

    private static readonly long S0 = TestData.SessionOpenMs;

    [Fact]
    public void PlanMarket_ShouldGiveAnUnknownBook_WhenNoDepthHasArrived()
    {
        var engine = NewEngine();
        engine.Apply(TestData.Status(T0, connected: true));

        var market = engine.PlanMarket(null);

        (market.Book.Known, market.Book.Cells.Count).Should().Be((false, 0));
    }

    [Fact]
    public void PlanMarket_ShouldGiveEveryCoveredPriceWithItsQuantity_WhenTheBookIsKnown()
    {
        var engine = LiveEngine();

        var book = engine.PlanMarket(null).Book;

        // Best bid 23999, best ask 24000, ten levels a side: covered 23990 to 24009, empty levels known as zero.
        (book.CoveredLow, book.CoveredHigh, book.Cells.Count).Should().Be((23_990L, 24_009L, 20));
        (book.QuantityAt(BookSide.Bid, 23_999), book.QuantityAt(BookSide.Bid, 23_990), book.QuantityAt(BookSide.Ask, 24_000))
            .Should().Be((10L, 0L, 10L));
    }

    [Fact]
    public void PlanMarket_ShouldGiveTheLastPriceAndTheClosedMinutes_WhenTradesHaveClosedAMinute()
    {
        var engine = LiveEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, 24_002, 1, BookSide.Bid, "a"));
        engine.Apply(TestData.Trade(T0 + 2_000, 23_998, 1, BookSide.Ask, "b"));
        engine.Apply(TestData.Trade(T0 + 61_000, 24_001, 1, BookSide.Bid, "c"));

        var market = engine.PlanMarket(null);

        market.LastTicks.Should().Be(24_001);
        var minute = market.Minutes.Single(m => m.StartMs == T0);
        (minute.High, minute.Low, minute.Missing).Should().Be((24_002L, 23_998L, false));
    }

    [Fact]
    public void PlanMarket_ShouldSumAskMinusBidVolumeAtEachPrice_WhenThisSessionTraded()
    {
        var engine = LiveEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, 24_000, 5, BookSide.Bid, "a"));
        engine.Apply(TestData.Trade(T0 + 2_000, 24_000, 2, BookSide.Ask, "b"));

        var market = engine.PlanMarket(null);

        market.SessionDeltaByPrice[24_000].Should().Be(3);
    }

    [Fact]
    public void PlanMarket_ShouldKeepTheWholeSessionsDeltaAtAPrice_WhenMoreFootprintsHaveClosedThanAreRetained()
    {
        var engine = LiveEngine();
        var retained = new OrderFlowOptions().FootprintRetentionBars;
        engine.Apply(TestData.Trade(T0 + 1_000, 24_000, 5, BookSide.Bid, "early"));

        // One print a minute at another price closes more one-minute footprints than the analyzer keeps.
        for (var i = 1; i <= retained + 10; i++)
        {
            engine.Apply(TestData.Trade(T0 + (i * 60_000) + 1_000, 24_003, 1, BookSide.Ask, $"later-{i}"));
        }

        var market = engine.PlanMarket(null);

        market.SessionDeltaByPrice[24_000].Should().Be(5);
    }

    [Fact]
    public void PlanMarket_ShouldStartTheSessionDeltaAgain_WhenANewSessionOpens()
    {
        var engine = LiveEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, 24_000, 5, BookSide.Bid, "old-session"));

        // T0 is 14:00 UTC; the next Globex session opens at 23:00 UTC.
        engine.Apply(TestData.Trade(T0 + (9 * 3_600_000) + 60_000, 24_000, 2, BookSide.Ask, "new-session"));

        engine.PlanMarket(null).SessionDeltaByPrice[24_000].Should().Be(-2);
    }

    [Fact]
    public void PlanMarket_ShouldGiveTheSliceLength_WhenRead()
    {
        LiveEngine().PlanMarket(null).SliceMs.Should().Be(1_000);
    }

    [Fact]
    public void PlanMarket_ShouldIncludeTheOverlayLevels_WhenAnOverlayIsCurrent()
    {
        var engine = LiveEngine();
        var overlay = Overlay(expiresAt: TestData.Epoch.AddHours(1));

        var market = engine.PlanMarket(overlay);

        market.Levels.Should().ContainSingle(l => l.Kind == "overlay").Which.Should().Be(new Core.Plans.PlanLevel("overlay", "synthetic shelf", 24_004));
    }

    [Fact]
    public void PlanMarket_ShouldLeaveOutTheOverlayLevels_WhenTheOverlayHasExpired()
    {
        var engine = LiveEngine();
        var overlay = Overlay(expiresAt: TestData.Epoch.AddMinutes(-1));

        var market = engine.PlanMarket(overlay);

        market.Levels.Should().NotContain(l => l.Kind == "overlay");
    }

    [Fact]
    public void PlanMarket_ShouldGiveTheRegimeOfEachTimeframe_WhenRead()
    {
        var market = LiveEngine().PlanMarket(null);

        market.Regimes.Select(r => r.TimeframeSeconds).Should().Equal(300, 900);
    }

    [Fact]
    public void PlanMarket_ShouldReportEveryCoverageFlagClear_WhenTheSessionWasCollectedFromItsOpenWithoutAGap()
    {
        var engine = FromSessionOpen();

        var market = engine.PlanMarket(null);

        market.Coverage.Should().Be(new PlanCoverage());
        market.Minutes.Should().NotBeEmpty().And.OnlyContain(m => !m.Missing);
    }

    [Fact]
    public void PlanMarket_ShouldFlagTheFlowAndTheMissingTime_WhileADroppedTradeHoleIsOpen()
    {
        var engine = FromSessionOpen();
        engine.MarkMissing(S0 + 120_000);

        var coverage = engine.PlanMarket(null).Coverage;

        (coverage.FlowPartial, coverage.MissingSinceMs).Should().Be((true, S0 + 120_000));
    }

    [Fact]
    public void PlanMarket_ShouldKeepTheFlowPartialButClearTheMissingTime_WhenTheFeedHasResubscribedAfterAHole()
    {
        var engine = FromSessionOpen();
        engine.MarkMissing(S0 + 120_000);
        Resubscribe(engine, S0 + 240_000);

        var coverage = engine.PlanMarket(null).Coverage;

        // CVD is anchored again by the resubscribe; only the session's recorded hole still says the flow is partial.
        engine.Status().CvdKnown.Should().BeTrue();
        (coverage.FlowPartial, coverage.MissingSinceMs).Should().Be((true, null));
    }

    [Fact]
    public void PlanMarket_ShouldGiveTheProfilePartialTimeAndAPartialVwap_WhenTheSessionWasJoinedLate()
    {
        // T0 is 15 hours after the 23:00 UTC open, so the first print starts a session already under way.
        var engine = LiveEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, 24_000, 1, BookSide.Bid, "late"));

        var coverage = engine.PlanMarket(null).Coverage;

        (coverage.ProfilePartialSinceMs, coverage.VwapPartial, coverage.FlowPartial).Should().Be((T0 + 1_000, true, true));
    }

    [Fact]
    public void PlanMarket_ShouldMarkAMinuteInsideAHoleMissing_WhenTheMinuteBesideItWasRepairedFromABar()
    {
        var engine = FromSessionOpen();
        engine.Tick(S0 + 300_000);
        engine.Apply(TestData.Status(S0 + 300_000, connected: true));
        engine.MarkMissing(S0 + 60_000);
        engine.ArmGapRepair();
        Resubscribe(engine, S0 + 180_000);

        // Only the first minute of the hole comes back from history; the second stays a hole.
        var repair = engine.ApplyApproximateMinutes([new HistoricalMinuteBar(S0 + 60_000, 23_998, 24_008, 23_996, 24_004, 9)]);

        repair.MinutesWritten.Should().Be(1);

        var minutes = engine.PlanMarket(null).Minutes;
        minutes.Single(m => m.StartMs == S0).Missing.Should().BeFalse("the minute before the hole was collected");
        minutes.Single(m => m.StartMs == S0 + 60_000).Missing.Should().BeFalse("a bar-repaired minute has a known range");
        minutes.Single(m => m.StartMs == S0 + 120_000).Missing.Should().BeTrue();
    }

    // Collected from the 23:00 UTC open: the first print lands inside the session's first minute, so nothing is partial.
    private static InstrumentEngine FromSessionOpen()
    {
        var engine = NewEngine();
        engine.Apply(TestData.Status(S0, connected: true));
        engine.Apply(TestData.Snapshot(S0));
        engine.Apply(TestData.Trade(S0 + 30_000, 24_000, 2, BookSide.Bid, "open-1"));
        engine.Apply(TestData.Trade(S0 + 50_000, 24_001, 1, BookSide.Ask, "open-2"));
        engine.Tick(S0 + 61_000);
        return engine;
    }

    private static void Resubscribe(InstrumentEngine engine, long timeMs)
    {
        engine.Apply(new BookResetEvent
        {
            Root = InstrumentRoot.MES,
            ContractId = InstrumentCatalog.MES.ContractId,
            SourceTimeMs = timeMs,
            ReceivedTimeMs = timeMs,
            Epoch = 2,
            Sequence = 1,
            Reason = BookResetEvent.SubscribedReason,
        });
        engine.Apply(TestData.Snapshot(timeMs) with { Resubscribe = true, GatewayTimeMs = timeMs, Epoch = 2 });
    }

    private static Overlay Overlay(DateTimeOffset expiresAt) => new()
    {
        Root = InstrumentRoot.MES,
        Publisher = "synthetic-agent",
        AvailableAt = TestData.Epoch.AddMinutes(-5),
        Request = new OverlayRequest
        {
            ContractId = TestData.EsContract,
            Version = 1,
            GeneratedAt = TestData.Epoch.AddMinutes(-5),
            AsOf = TestData.Epoch.AddMinutes(-5),
            ExpiresAt = expiresAt,
            Levels = [new OverlayLevel { Price = 6001.00m, Label = "synthetic shelf" }],
        },
    };

    private static InstrumentEngine NewEngine() => new(InstrumentCatalog.MES, null, TestData.Calendar());

    private static InstrumentEngine LiveEngine()
    {
        var engine = NewEngine();
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));
        return engine;
    }
}
