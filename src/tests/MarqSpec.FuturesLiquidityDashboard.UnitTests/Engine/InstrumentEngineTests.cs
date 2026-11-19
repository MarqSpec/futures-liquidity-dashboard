using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Regime;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Engine;

// reference: REQUIREMENTS.md FR-4, FR-5, FR-11, FR-13, FR-14, FR-17, FR-69, NFR-1 (INTERFACES.md Interface A)
public sealed class InstrumentEngineTests
{
    private const long Px = TestData.EsBase;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Status_ShouldBeRecoveringWithAnUnknownBook_WhenNothingHasArrived()
    {
        var status = NewEngine().Status();

        status.Code.Should().Be("RECOVERING");
        status.BookKnown.Should().BeFalse();
        status.Provenance.Should().Be("SIMULATED");
    }

    [Theory]
    [InlineData(FeedProvenance.Simulated, "SIMULATED")]
    [InlineData(FeedProvenance.Live, "LIVE")]
    [InlineData(FeedProvenance.Replay, "REPLAY")]
    public void Apply_ShouldMakeTheBookKnownAndShowTheProvenance_WhenConnectedAndASnapshotArrives(FeedProvenance provenance, string code)
    {
        var engine = NewEngine();

        engine.Apply(TestData.Status(T0, connected: true, provenance));
        engine.Apply(TestData.Snapshot(T0));

        var status = engine.Status();
        status.Code.Should().Be(code);
        status.BookKnown.Should().BeTrue();
        (status.CoveredLow, status.CoveredHigh, status.LevelsPerSide).Should().Be((Px - 10, Px + 9, 10));
    }

    [Fact]
    public void Apply_ShouldMakeTheBookUnknown_WhenTheUpstreamResetsIt()
    {
        var engine = LiveEngine();

        engine.Apply(TestData.Reset(T0 + 100));

        var status = engine.Status();
        status.Code.Should().Be("RECOVERING");
        status.BookKnown.Should().BeFalse();
        status.BookResets.Should().Be(1);
    }

    [Fact]
    public void Apply_ShouldMakeTheBookUnknown_WhenTheFeedDisconnects()
    {
        var engine = LiveEngine();

        engine.Apply(TestData.Status(T0 + 100, connected: false));

        var status = engine.Status();
        status.Code.Should().Be("RECOVERING");
        status.Connected.Should().BeFalse();
        status.BookKnown.Should().BeFalse();
        engine.Snapshot(60, null).Ladder.Bids.Should().BeEmpty();
    }

    [Fact]
    public void Snapshot_ShouldListOnlyReceivedLevels_WhenTheBookIsShallowerThanTheLadder()
    {
        // MGC and SIL arrive with 10 prices. A 40-level ladder must not pad the missing ones.
        var engine = new InstrumentEngine(InstrumentCatalog.MES, EngineOptions.Default with { LadderLevels = 40 }, TestData.Calendar());
        engine.Apply(TestData.Status(T0, connected: true));
        var bids = Enumerable.Range(0, 10).Select(i => new BookLevel(Px - 1 - i, 3 + i)).ToList();
        var asks = Enumerable.Range(0, 10).Select(i => new BookLevel(Px + i, 4 + i)).ToList();
        engine.Apply(TestData.Snapshot(T0, bids, asks, levelsPerSide: 50));

        var ladder = engine.Snapshot(60, null).Ladder;

        ladder.Bids.Should().HaveCount(10);
        ladder.Asks.Should().HaveCount(10);
        ladder.Bids.Concat(ladder.Asks).Should().OnlyContain(row => row.Count == 2 && row[1] > 0);
    }

    [Fact]
    public void Apply_ShouldDropDepthUpdates_WhenTheBookIsUnknown()
    {
        var engine = NewEngine();

        engine.Apply(TestData.Depth(T0, BookSide.Bid, Px - 1, 5));

        engine.Status().DroppedWhileUnknown.Should().Be(1);
    }

    [Theory]
    [InlineData(3_000, "SIMULATED")]
    [InlineData(3_001, "STALE")]
    public void Tick_ShouldReportStale_WhenNoEventArrivesForLongerThanTheStaleWindow(int silenceMs, string code)
    {
        var engine = LiveEngine();

        engine.Tick(T0 + silenceMs);

        engine.Status().Code.Should().Be(code);
    }

    [Fact]
    public void Tick_ShouldNotReportStale_WhenTheExchangeIsClosed()
    {
        // Saturday 2026-11-14 12:00 CT: no session is open, so silence is expected.
        var saturday = new DateTimeOffset(2026, 11, 14, 18, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
        var engine = NewEngine();
        engine.Apply(TestData.Status(saturday, connected: true));
        engine.Apply(TestData.Snapshot(saturday));

        engine.Tick(saturday + 60_000);

        engine.Status().Code.Should().NotBe("STALE");
    }

    [Fact]
    public void Apply_ShouldBuildOneMinuteBarsFromTrades_WhenAMinuteCloses()
    {
        var engine = NewEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, Px, 2, BookSide.Bid, "t1"));
        engine.Apply(TestData.Trade(T0 + 30_000, Px + 4, 1, BookSide.Ask, "t2"));
        engine.Apply(TestData.Trade(T0 + 59_999, Px - 2, 3, BookSide.Bid, "t3"));

        engine.Apply(TestData.Trade(T0 + 61_000, Px + 1, 1, BookSide.Bid, "t4"));

        engine.Context().RecentMinuteBars.Should().ContainSingle()
            .Which.Should().Be(new BarDto(T0, 60_000, Px, Px + 4, Px - 2, Px - 2, V: 6, Bv: 5, Sv: 1, N: 3));
    }

    [Fact]
    public void Snapshot_ShouldIncludeTheWarmupBars_WhenNoLiveEventHasArrivedYet()
    {
        var engine = NewEngine();
        engine.LoadHistory(
            [TestData.Trade(T0 - 120_000, Px, 2, BookSide.Bid, "h1"), TestData.Trade(T0 - 1_000, Px + 1, 3, BookSide.Ask, "h2")],
            collectionStartMs: T0);

        engine.Snapshot(60, null).Bars.Should().NotBeEmpty();
    }

    [Theory]
    [InlineData(59_000, false)]
    [InlineData(60_000, false)]
    [InlineData(60_001, true)]
    [InlineData(1_060_000, true)]
    public void Apply_ShouldRejectTheEvent_OnlyWhenItsSourceTimeIsMoreThanAMinuteAheadOfItsReceiveTime(long aheadMs, bool rejected)
    {
        var engine = LiveEngine();
        var before = engine.RejectedEvents;
        var source = T0 + 1_000;

        engine.Apply(TestData.Trade(source, Px, 1, BookSide.Bid, "ahead") with { ReceivedTimeMs = source - aheadMs });

        engine.RejectedEvents.Should().Be(rejected ? before + 1 : before);
        engine.ClockAheadRejectedEvents.Should().Be(rejected ? 1 : 0, "a clock-ahead refusal is also counted on its own");
        engine.Status().ClockAheadRejectedEvents.Should().Be(rejected ? 1 : 0);
        engine.Snapshot(60, null).Liquidity.SessionVolume.Should().Be(rejected ? 0 : 1);
    }

    [Fact]
    public void Apply_ShouldDropALiveTrade_WhenItIsAtOrBeforeTheHistoryWatermark()
    {
        var engine = NewEngine();
        engine.LoadHistory(
            [TestData.Trade(T0 - 2_000, Px, 2, BookSide.Bid, "h1"), TestData.Trade(T0 - 1_000, Px, 3, BookSide.Ask, "h2")],
            collectionStartMs: T0);

        engine.Apply(TestData.Trade(T0 - 1_000, Px, 5, BookSide.Bid, "live-1"));

        var snapshot = engine.Snapshot(60, null);
        snapshot.HistoryWatermarkMs.Should().Be(T0 - 1_000);
        snapshot.Liquidity.SessionVolume.Should().Be(5);
        snapshot.Status.DuplicateTrades.Should().Be(0);
    }

    [Fact]
    public void Apply_ShouldCountALiveTrade_WhenItIsAfterTheHistoryWatermark()
    {
        var engine = NewEngine();
        engine.LoadHistory([TestData.Trade(T0 - 1_000, Px, 3, BookSide.Ask, "h1")], collectionStartMs: T0);

        engine.Apply(TestData.Trade(T0 + 1_000, Px, 7, BookSide.Bid, "live-1"));

        engine.Snapshot(60, null).Liquidity.SessionVolume.Should().Be(10);
    }

    [Fact]
    public void Apply_ShouldCountTheDuplicateAndApplyItOnce_WhenATradeIdRepeats()
    {
        var engine = NewEngine();
        var trade = TestData.Trade(T0, Px, 4, BookSide.Bid, "dup");

        engine.Apply(trade);
        engine.Apply(trade with { Sequence = trade.Sequence + 1, SourceTimeMs = T0 + 10 });

        var snapshot = engine.Snapshot(60, null);
        snapshot.Status.DuplicateTrades.Should().Be(1);
        snapshot.Liquidity.SessionVolume.Should().Be(4);
    }

    [Theory]
    [InlineData("ES", "ESH27")]
    [InlineData("MES", "ESH27")]
    [InlineData("GC", TestData.EsContract)]
    [InlineData("MGC", TestData.EsContract)]
    public void Apply_ShouldRejectTheEvent_WhenItIsForAnotherContract(string rootName, string contractId)
    {
        var root = InstrumentRoot.Parse(rootName);
        var engine = NewEngine();

        engine.Apply(TestData.Trade(T0, Px, 4, BookSide.Bid, "x1", contractId, root));

        engine.RejectedEvents.Should().Be(1);
        engine.Status().RejectedEvents.Should().Be(1);
        engine.ClockAheadRejectedEvents.Should().Be(0, "a wrong contract is not a clock problem");
        engine.Snapshot(60, null).Liquidity.SessionVolume.Should().Be(0);
    }

    [Fact]
    public void Publish_ShouldIncrementTheSequenceByOne_WhenCalledRepeatedly()
    {
        var engine = LiveEngine();

        var first = engine.Publish(null);
        var second = engine.Publish(null);

        (first.Seq, second.Seq, engine.Snapshot(60, null).Seq).Should().Be((1L, 2L, 2L));
    }

    [Fact]
    public void Publish_ShouldCarryANewSignalOnce_WhenAnIcebergIsDetected()
    {
        var engine = LiveEngine();
        PlayIceberg(engine);

        var first = engine.Publish(null);
        var second = engine.Publish(null);

        first.OrderFlow.Signals.Should().ContainSingle().Which.Kind.Should().Be(SignalKind.Iceberg);
        second.OrderFlow.Signals.Should().BeEmpty();
        second.OrderFlow.LastSignalId.Should().Be(first.OrderFlow.LastSignalId);
    }

    [Fact]
    public void Publish_ShouldCarryAClosedFootprintOnce_WhenAFootprintBarCloses()
    {
        var engine = LiveEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, Px, 3, BookSide.Bid, "f1"));
        engine.Apply(TestData.Trade(T0 + 61_000, Px + 1, 1, BookSide.Bid, "f2"));

        var first = engine.Publish(null);
        var second = engine.Publish(null);

        first.OrderFlow.Footprints.Should().ContainSingle().Which.T.Should().Be(T0);
        second.OrderFlow.Footprints.Should().BeEmpty();
        second.Bars.Should().BeEmpty();
    }

    [Fact]
    public void PublishIfWatched_ShouldBuildNothing_WhileNobodyWatches_AndLeaveNoSequenceGap()
    {
        var engine = LiveEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, Px, 3, BookSide.Bid, "w1"));
        engine.Apply(TestData.Trade(T0 + 61_000, Px + 1, 1, BookSide.Bid, "w2"));

        engine.PublishIfWatched(null).Should().BeNull();
        engine.PublishIfWatched(null).Should().BeNull();
        var snapshot = engine.Watch(60, null);
        var delta = engine.PublishIfWatched(null)!;

        engine.Watchers.Should().Be(1);
        snapshot.Seq.Should().Be(2);
        snapshot.Bars.Should().NotBeEmpty();
        delta.Seq.Should().Be(snapshot.Seq + 1);
        delta.Bars.Should().BeEmpty("the snapshot already carried the bar the skipped publications closed");
        delta.OrderFlow.Footprints.Should().BeEmpty();
    }

    [Fact]
    public void Unwatch_ShouldNeverGoBelowZero_AndStopTheDeltas()
    {
        var engine = LiveEngine();
        engine.Watch(60, null);

        engine.Unwatch();
        engine.Unwatch();

        engine.Watchers.Should().Be(0);
        engine.PublishIfWatched(null).Should().BeNull();
    }

    [Fact]
    public void Summary_ShouldCarryTheLatestSignal_AndOneRegimePerTimeframe()
    {
        var engine = LiveEngine();
        PlayIceberg(engine);

        var summary = engine.Summary();

        summary.LatestSignal!.Kind.Should().Be(SignalKind.Iceberg);
        summary.Signals15m.Should().Be(1);
        summary.Regimes!.Select(r => r.TimeframeSeconds).Should().Equal(300, 900);
        summary.Regimes.Should().OnlyContain(r => !r.Ready && r.Trend == TrendRegime.Unknown);
    }

    [Fact]
    public void Snapshot_ShouldIncludeMoreThanOneHundredOfOneKind_WhenTheyAreInsideTheRequestedHistory()
    {
        var engine = StackedEngine(cap: 20_000, historyMinutes: 3 * 24 * 60);

        PlayStackedBars(engine, 120);

        var stacked = engine.Snapshot(180, null).OrderFlow.Signals.Where(s => s.Kind == SignalKind.StackedImbalance).ToList();

        stacked.Should().HaveCount(120);
        (stacked[^1].TimeMs - stacked[0].TimeMs).Should().BeGreaterThan(100 * 60_000);
    }

    [Fact]
    public void Snapshot_ShouldOmitSignalsOutsideTheRequestedHistory_WhenTheEngineStillRetainsThem()
    {
        var engine = StackedEngine(cap: 20_000, historyMinutes: 3 * 24 * 60);
        PlayStackedBars(engine, 30);
        var now = T0 + (30 * 60_000);

        var wide = engine.Snapshot(30, null).OrderFlow.Signals;
        var narrow = engine.Snapshot(10, null).OrderFlow.Signals;

        wide.Should().HaveCount(30);
        wide.Should().Contain(s => s.TimeMs == T0 + 60_000);
        narrow.Should().NotBeEmpty();
        narrow.Should().HaveCountLessThan(wide.Count);
        narrow.Should().OnlyContain(s => s.TimeMs >= now - (10 * 60_000));
        narrow.Should().NotContain(s => s.TimeMs == T0 + 60_000);
    }

    [Fact]
    public void Snapshot_ShouldKeepOnlyTheNewestSignals_WhenTheCapIsReached()
    {
        var engine = StackedEngine(cap: 10, historyMinutes: 3 * 24 * 60);

        PlayStackedBars(engine, 30);

        var signals = engine.Snapshot(180, null).OrderFlow.Signals;
        signals.Should().HaveCount(10);
        signals.Should().OnlyContain(s => s.Kind == SignalKind.StackedImbalance);
        signals.Min(s => s.TimeMs).Should().BeGreaterThan(T0 + 60_000);
        signals.Max(s => s.TimeMs).Should().Be(T0 + (30 * 60_000));
    }

    [Fact]
    public void Summary_ShouldNotCountSignalsOlderThanHistoryRetention_WhenTheClockHasMovedPastThem()
    {
        var engine = StackedEngine(cap: 20_000, historyMinutes: 5);

        PlayStackedBars(engine, 20);

        var summary = engine.Summary();
        var snapshot = engine.Snapshot(60, null).OrderFlow.Signals;

        summary.Signals15m.Should().BeLessThan(10);
        snapshot.Should().HaveCount(summary.Signals15m);
        snapshot.Should().NotContain(s => s.TimeMs == T0 + 60_000);
        snapshot.Should().OnlyContain(s => s.TimeMs >= T0 + (20 * 60_000) - (5 * 60_000));
    }

    [Fact]
    public void Publish_ShouldOmitSignalsAlreadyPublished_WhenTheLogStillHoldsThem()
    {
        var engine = StackedEngine(cap: 20_000, historyMinutes: 60);
        PlayStackedBars(engine, 4);

        var first = engine.Publish(null);
        PlayStackedBars(engine, 1, startMinute: 4);
        var second = engine.Publish(null);

        first.OrderFlow.Signals.Should().HaveCount(4);
        second.OrderFlow.Signals.Should().ContainSingle().Which.TimeMs.Should().Be(T0 + (5 * 60_000));
        engine.Snapshot(60, null).OrderFlow.Signals.Should().HaveCount(5);
    }

    [Fact]
    public void Snapshot_ShouldListTheIceberg_WhenRefillsWereSeenOnTheLiveBook()
    {
        var engine = LiveEngine();

        PlayIceberg(engine);

        engine.Snapshot(60, null).OrderFlow.Icebergs.Should().ContainSingle().Which.PriceTicks.Should().Be(Px);
    }

    [Fact]
    public void Context_ShouldReportPricesInContractUnits_WhenTradesWereApplied()
    {
        var engine = NewEngine();

        engine.Apply(TestData.Trade(T0, Px + 1, 1, BookSide.Bid, "c1"));

        engine.Context().LastPrice.Should().Be(6000.25m);
    }

    [Theory]
    [InlineData("ES", 0, 4)]
    [InlineData("MES", 0, 4)]
    [InlineData("GC", 0, 10)]
    [InlineData("MGC", 0, 10)]
    [InlineData("CL", 0, 5)]
    [InlineData("MCL", 0, 5)]
    [InlineData("CL", 7, 7)]
    [InlineData("MCL", 7, 7)]
    public void TpoRowTicks_ShouldUseTheInstrumentDefault_WhenNoneIsConfigured(string rootName, int configured, int expected)
    {
        var root = InstrumentRoot.Parse(rootName);
        InstrumentEngine.TpoRowTicks(InstrumentCatalog.For(root), configured).Should().Be(expected);
    }

    [Fact]
    public void Snapshot_ShouldPublishEveryViewerTimeframe_WhenMinuteBarsClose()
    {
        var engine = NewEngine();
        for (var minute = 1; minute <= 80; minute++)
        {
            engine.Apply(TestData.Trade(T0 + (minute * 60_000), Px + (minute % 7), 1, BookSide.Bid, $"m{minute}"));
        }

        var indicators = engine.Snapshot(60, null).Indicators;
        indicators.Where(i => i.Id == "ema10").Select(i => i.Tf).Should().BeEquivalentTo([60, 300, 900]);
        indicators.Should().ContainSingle(i => i.Id == "ema10" && i.Tf == 60 && i.Ready);
        indicators.Should().ContainSingle(i => i.Id == "ema10" && i.Tf == 300 && i.Ready);
        indicators.Should().Contain(i => i.Id == "ema10" && i.Tf == 900);
    }

    [Fact]
    public void Context_ShouldKeepOneSeriesPerId_WhenASlowerTimeframeIsAlsoReady()
    {
        var engine = NewEngine();
        for (var minute = 1; minute <= 80; minute++)
        {
            engine.Apply(TestData.Trade(T0 + (minute * 60_000), Px + (minute % 7), 1, BookSide.Bid, $"c{minute}"));
        }

        var context = engine.Context();

        context.Indicators.Should().ContainKey("ema10");
        context.Indicators.Keys.Should().OnlyHaveUniqueItems();
        context.Indicators.Should().HaveCountLessThan(engine.Snapshot(60, null).Indicators.Count(i => i.Ready));
    }

    [Fact]
    public void Snapshot_ShouldRollClosedSlicesIntoAMinuteColumn_WhenTheMinuteEnds()
    {
        var engine = LiveEngine();

        engine.Tick(T0 + 61_000);

        engine.Snapshot(60, null).MinuteHeat.Should().Contain(c => c.T == T0 && c.D == 60_000);
    }

    [Fact]
    public void Quote_ShouldNameTheNearestLevelAndItsTouches_WhenPriceHasApproachedIt()
    {
        var engine = NewEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, Px, 1, BookSide.Bid, "q1"));
        engine.Apply(TestData.Trade(T0 + 61_000, Px + 40, 1, BookSide.Bid, "q2"));
        engine.Apply(TestData.Trade(T0 + 121_000, Px, 1, BookSide.Bid, "q3"));

        var quote = engine.Quote();

        quote.ChangeTicks.Should().Be(0);
        quote.Levels.Should().Contain(level => level.Name == "Session low" && level.Touches >= 2);
    }

    private static InstrumentEngine NewEngine() => new(InstrumentCatalog.MES, null, TestData.Calendar());

    /// <summary>Stacked imbalances only, so a bar closes as one signal and the cap is the whole log.</summary>
    private static InstrumentEngine StackedEngine(int cap, int historyMinutes) => new(
        InstrumentCatalog.MES,
        EngineOptions.Default with
        {
            HistoryRetentionMinutes = historyMinutes,
            OrderFlow = OrderFlowOptions.Default with
            {
                SignalHistoryCap = cap,
                EnableIcebergs = false,
                EnableTrappedTraders = false,
                EnableCvdDivergence = false,
                EnableDeltaExhaustion = false,
                EnableSpoofs = false,
                EnableSweeps = false,
                EnableSinglePrints = false,
            },
        },
        TestData.Calendar());

    private static void PlayStackedBars(InstrumentEngine engine, int bars, int startMinute = 0)
    {
        for (var i = 0; i < bars; i++)
        {
            var minute = startMinute + i;
            var start = T0 + (minute * 60_000L);
            var t = start + 1_000;
            foreach (var (offset, bid, ask) in new (int Offset, long Bid, long Ask)[] { (0, 2, 0), (1, 2, 6), (2, 2, 6), (3, 1, 6) })
            {
                var price = Px + offset;
                if (bid > 0)
                {
                    engine.Apply(TestData.Trade(t++, price, bid, BookSide.Ask, $"b{minute}-{offset}"));
                }

                if (ask > 0)
                {
                    engine.Apply(TestData.Trade(t++, price, ask, BookSide.Bid, $"a{minute}-{offset}"));
                }
            }

            engine.Tick(start + 60_000);
        }
    }

    /// <summary>Connected (simulated provenance) with a known book: bids 23995–23999 and asks 24000–24004 of 10.</summary>
    private static InstrumentEngine LiveEngine()
    {
        var engine = NewEngine();
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));
        return engine;
    }

    /// <summary>Two buys of 8 lift the 10-lot offer at 24000, which drops and refills within the window each time.</summary>
    private static void PlayIceberg(InstrumentEngine engine)
    {
        var id = 0;
        foreach (var start in new[] { T0 + 100, T0 + 500 })
        {
            engine.Apply(TestData.Trade(start, Px, 8, BookSide.Bid, $"ice-{++id}"));
            engine.Apply(TestData.Depth(start + 50, BookSide.Ask, Px, 2));
            engine.Apply(TestData.Depth(start + 200, BookSide.Ask, Px, 10));
        }
    }
}
