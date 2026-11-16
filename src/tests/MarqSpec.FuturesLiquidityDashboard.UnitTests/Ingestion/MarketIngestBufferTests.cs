using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.Profile;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: REQUIREMENTS.md NFR-4; ARCHITECTURE.md D-32; ARCHITECTURE.md T-6
public sealed class MarketIngestBufferTests
{
    private static readonly InstrumentSpec Mes = InstrumentCatalog.MES;
    private static readonly InstrumentSpec Mcl = InstrumentCatalog.MCL;

    [Fact]
    public void Drain_ShouldApplyTheResetBeforeLaterLevels_WhenAResetIsInTheSameWindow()
    {
        var buffer = Buffer(8, 32);
        buffer.Submit(Depth(1, 100, 5));
        buffer.Submit(Reset(2));
        buffer.Submit(Depth(3, 100, 9));

        var drained = buffer.Drain();
        drained.Should().HaveCount(2);
        drained[0].Should().BeOfType<BookResetEvent>();
        drained[1].Should().BeOfType<DepthUpdateEvent>().Which.Quantity.Should().Be(9);
    }

    [Fact]
    public void Submit_ShouldKeepAZeroQuantity_WhenItReplacesARestingLevel()
    {
        var buffer = Buffer(8, 32);
        buffer.Submit(Depth(1, 100, 5));
        buffer.Submit(Depth(2, 100, 0));

        buffer.QueuedDepthCount.Should().Be(1);
        buffer.Coalesced.Should().Be(1);
        buffer.Drain().Should().ContainSingle().Which.Should().BeOfType<DepthUpdateEvent>().Which.Quantity.Should().Be(0);
    }

    [Fact]
    public void Drain_ShouldOrderTheDisconnectAfterEarlierTrades_WhenDepthWasStillPending()
    {
        var buffer = Buffer(8, 32);
        buffer.Submit(Depth(1, 100, 5));
        buffer.Submit(Trade(2, Mes, 3));
        buffer.Submit(Status(3, connected: false));
        buffer.Submit(Trade(4, Mes, 1));

        var drained = buffer.Drain();
        drained.Select(e => e.Sequence).Should().Equal(2L, 3L, 4L);
        drained[0].Should().BeOfType<TradeEvent>();
        drained[1].Should().BeOfType<FeedStatusEvent>().Which.Connected.Should().BeFalse();
        drained[2].Should().BeOfType<TradeEvent>();
        buffer.DepthDiscarded.Should().Be(1);
        buffer.Coalesced.Should().Be(0);
    }

    [Fact]
    public void Submit_ShouldReturnImmediately_WhenTheQueueIsFullAndAnotherEventArrives()
    {
        var buffer = Buffer(2, 32);
        buffer.Submit(Trade(1, Mes, 1));
        buffer.Submit(Trade(2, Mes, 1));
        buffer.Submit(Trade(3, Mes, 1));
        buffer.Submit(Quote(4));
        buffer.Submit(Status(5, connected: false));

        buffer.QueuedTrades(Mes.Root).Should().Be(2);
        buffer.DroppedTrades.Should().Be(1);
        var drained = buffer.Drain();
        drained.OfType<QuoteEvent>().Should().NotBeEmpty();
        drained.OfType<FeedStatusEvent>().Should().Contain(status => status.Connected == false);
    }

    [Fact]
    public void Submit_ShouldLeaveTheQuietContractLive_WhenAnotherContractBursts()
    {
        var buffer = Buffer(2, 32);
        for (var i = 0; i < 6; i++)
        {
            buffer.Submit(Trade(i + 1, Mes, 1));
        }

        buffer.Submit(Trade(10, Mcl, 4));
        buffer.Submit(Trade(11, Mcl, 5));

        buffer.QueuedTrades(Mes.Root).Should().Be(2);
        buffer.DroppedTrades.Should().Be(4);
        buffer.QueuedTrades(Mcl.Root).Should().Be(2);
        buffer.TakeRecoveries().Should().ContainSingle()
            .Which.Should().Be(new IngestRecovery(Mes.Root, IngestRecoveryKind.Trades, TestData.EpochMs + 3, TestData.EpochMs + 6));
    }

    [Fact]
    public void TakeRecoveries_ShouldSpanEveryDroppedTrade_WhenLaterTradesAlsoDoNotFit()
    {
        var buffer = Buffer(1, 32);
        buffer.Submit(Trade(1, Mes, 1));
        buffer.Submit(Trade(10, Mes, 1));
        buffer.Submit(Trade(70_000, Mes, 1));

        var recovery = buffer.TakeRecoveries().Should().ContainSingle().Subject;
        recovery.Kind.Should().Be(IngestRecoveryKind.Trades);
        recovery.GapStartMs.Should().Be(TestData.EpochMs + 10);
        recovery.GapThroughMs.Should().Be(TestData.EpochMs + 70_000);
    }

    [Fact]
    public void TakeRecoveries_ShouldNotCarryAFarFutureStamp_WhenALaterOverflowTradeIsAhead()
    {
        var buffer = Buffer(1, 32);
        buffer.Submit(Trade(1, Mes, 1));
        buffer.Submit(Trade(2, Mes, 1));
        var received = TestData.EpochMs + 3;
        var far = received + InstrumentEngine.MaxClockAheadMs + 1;
        buffer.Submit(Trade(4, Mes, 1) with { SourceTimeMs = far, ReceivedTimeMs = received });

        var recovery = buffer.TakeRecoveries().Should().ContainSingle().Subject;
        recovery.GapStartMs.Should().Be(TestData.EpochMs + 2);
        recovery.GapThroughMs.Should().Be(received);
        recovery.GapThroughMs.Should().BeLessThan(far);
    }

    [Fact]
    public void Submit_ShouldCountADiscard_WhenDepthPricesPassTheCap()
    {
        var buffer = Buffer(8, 2);
        buffer.Submit(Depth(1, 100, 1));
        buffer.Submit(Depth(2, 101, 1));
        buffer.Submit(Depth(3, 102, 1));

        buffer.DepthDiscarded.Should().BeGreaterThan(0);
        buffer.Coalesced.Should().Be(0);
        buffer.TakeRecoveries().Should().ContainSingle().Which.Kind.Should().Be(IngestRecoveryKind.Depth);
        buffer.Drain().Should().BeEmpty();
    }

    [Fact]
    public void MarkMissing_ShouldKeepTheHoleAfterAResubscribe_AndLeaveAPreDropBarClear()
    {
        var engine = LiveEngine();
        engine.Apply(Trade(1_000, Mes, 4));
        var first = TestData.EpochMs + 90_000;
        engine.MarkMissing(first);
        engine.MarkMissing(first + 30_000);
        engine.Apply(Trade(100_000, Mes, 2));

        engine.Status().Code.Should().Be("DEGRADED");
        engine.Status().MissingSinceMs.Should().Be(first);
        engine.Status().CvdKnown.Should().BeFalse();
        var before = Bars(engine);
        before.Should().Contain(bar => !bar.Missing && bar.T == TestData.EpochMs);
        before.Should().Contain(bar => bar.Missing && bar.T == TestData.EpochMs + 60_000);

        engine.Apply(Reset(TestData.EpochMs + 110_000, "ingest overflow"));
        engine.Apply(TestData.Snapshot(TestData.EpochMs + 120_000));
        engine.Status().Code.Should().Be("DEGRADED");
        engine.Apply(Reset(TestData.EpochMs + 130_000, "gateway reset"));
        engine.Apply(TestData.Snapshot(TestData.EpochMs + 140_000));
        engine.Status().MissingSinceMs.Should().Be(first);

        engine.Apply(Reset(TestData.EpochMs + 150_000, BookResetEvent.SubscribedReason));
        engine.Apply(TestData.Snapshot(TestData.EpochMs + 160_000) with { Resubscribe = true });
        engine.Status().Code.Should().Be("SIMULATED");
        engine.Status().MissingSinceMs.Should().BeNull();
        engine.Status().CvdKnown.Should().BeTrue("a fresh resubscribe snapshot anchors CVD again");
        var after = Bars(engine);
        after.Should().Contain(bar => bar.Missing && bar.T == TestData.EpochMs + 60_000);
        engine.Apply(Trade(200_000, Mes, 1));
        Bars(engine).Should().Contain(bar => !bar.Missing && bar.T == TestData.EpochMs + 180_000);
        engine.Snapshot(60, null).Profiles.Should().Contain(profile =>
            profile.Window == "session" && profile.MissingRanges.Any(range => range[0] == first));

        engine.Apply(Trade((int)TimeSpan.FromHours(10).TotalMilliseconds, Mes, 1));
        engine.Status().CvdKnown.Should().BeTrue();
        engine.Status().MissingSinceMs.Should().BeNull();
        var rolled = engine.Snapshot(60, null).Profiles.ToList();
        rolled.Should().Contain(profile => profile.Window == "session" && profile.MissingRanges.Count == 0);
        rolled.Should().Contain(profile => profile.Window == "5d" && profile.MissingRanges.Any(range => range[0] == first));
    }

    [Fact]
    public void MarkMissing_ShouldKeepBothHoles_WhenASecondGapOpensInTheSameSession()
    {
        var engine = LiveEngine();
        engine.Apply(Trade(1_000, Mes, 1));
        var first = TestData.EpochMs + 90_000;
        engine.MarkMissing(first);
        engine.Apply(Trade(100_000, Mes, 1));
        engine.Apply(Reset(TestData.EpochMs + 150_000, BookResetEvent.SubscribedReason));
        engine.Apply(TestData.Snapshot(TestData.EpochMs + 160_000) with { Resubscribe = true });
        engine.Apply(Trade(200_000, Mes, 1));
        var second = TestData.EpochMs + 250_000;
        engine.MarkMissing(second);
        engine.Apply(Trade(260_000, Mes, 1));
        engine.Apply(Reset(TestData.EpochMs + 290_000, BookResetEvent.SubscribedReason));
        engine.Apply(TestData.Snapshot(TestData.EpochMs + 300_000) with { Resubscribe = true });
        engine.Apply(Trade(360_000, Mes, 1));

        var bars = Bars(engine);
        bars.Should().Contain(bar => !bar.Missing && bar.T == TestData.EpochMs);
        bars.Should().Contain(bar => bar.Missing && bar.T == TestData.EpochMs + 60_000);
        bars.Should().Contain(bar => !bar.Missing && bar.T == TestData.EpochMs + 180_000);
        bars.Should().Contain(bar => bar.Missing && bar.T == TestData.EpochMs + 240_000);
        bars.Should().Contain(bar => !bar.Missing && bar.T == TestData.EpochMs + 360_000);
        var ranges = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").MissingRanges;
        ranges.Select(range => range[0]).Should().Equal(first, second);
        engine.Status().MissingSinceMs.Should().BeNull();
        engine.Status().CvdKnown.Should().BeTrue();
    }

    [Fact]
    public void MarkMissing_ShouldNotExtendTheHole_WhenALaterDropIsStampedFarAhead()
    {
        var engine = LiveEngine();
        engine.Apply(Trade(1_000, Mes, 1));
        var first = TestData.EpochMs + 30_000;
        var gateway = TestData.EpochMs + 80_000;
        var returned = TestData.EpochMs + 90_000;
        engine.MarkMissing(first);
        engine.Apply(Trade(40_000, Mes, 1));
        engine.MarkMissing(returned + InstrumentEngine.MaxClockAheadMs + 1);
        engine.Apply(Reset(returned, BookResetEvent.SubscribedReason));
        engine.Apply(TestData.Snapshot(returned) with { Resubscribe = true, GatewayTimeMs = gateway });
        engine.Apply(Trade(120_000, Mes, 1));
        engine.Apply(Trade(180_000, Mes, 1));

        engine.Status().MissingSinceMs.Should().BeNull();
        var range = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").MissingRanges.Should().ContainSingle().Subject;
        range[0].Should().Be(first);
        range[1].Should().Be(gateway);
        var bars = Bars(engine);
        bars.Should().Contain(bar => bar.Missing && bar.T == TestData.EpochMs);
        bars.Should().Contain(bar => !bar.Missing && bar.T == TestData.EpochMs + 120_000);
        bars.Should().Contain(bar => !bar.Missing && bar.T == TestData.EpochMs + 180_000);
    }

    [Fact]
    public void MarkMissing_ShouldIncludeTheBarThatStartsOnTheLastDrop_WhenThatStampEndsTheHole()
    {
        var engine = LiveEngine();
        var first = TestData.EpochMs + 30_000;
        var boundary = TestData.EpochMs + 60_000;
        engine.MarkMissing(first);
        engine.Apply(Trade(60_000, Mes, 1));
        engine.MarkMissing(boundary);
        var returned = TestData.EpochMs + 50_000;
        engine.Apply(Reset(returned, BookResetEvent.SubscribedReason));
        engine.Apply(TestData.Snapshot(returned) with { Resubscribe = true, GatewayTimeMs = first });

        var range = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").MissingRanges.Should().ContainSingle().Subject;
        range[1].Should().Be(boundary + 1);
        Bars(engine).Should().Contain(bar => bar.Missing && bar.T == boundary);
    }

    [Fact]
    public void MarkMissing_ShouldKeepLaterDropsFlagged_WhenTheStreamDiesOnTheFirstDrop()
    {
        var engine = LiveEngine();
        engine.Apply(Trade(1_000, Mes, 1));
        var first = TestData.EpochMs + 30_000;
        var later = TestData.EpochMs + 90_000;
        var returned = TestData.EpochMs + 150_000;
        engine.MarkMissing(first);
        engine.Apply(Trade(70_000, Mes, 1));
        engine.MarkMissing(later);
        engine.Apply(Reset(returned, BookResetEvent.SubscribedReason));
        engine.Apply(TestData.Snapshot(returned) with { Resubscribe = true, GatewayTimeMs = first });
        engine.Apply(Trade(180_000, Mes, 1));

        engine.Status().MissingSinceMs.Should().BeNull();
        var range = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").MissingRanges.Should().ContainSingle().Subject;
        range[0].Should().Be(first);
        range[1].Should().Be(returned);
        range[1].Should().NotBe(first + 1);
        var bars = Bars(engine);
        bars.Should().Contain(bar => bar.Missing && bar.T == TestData.EpochMs + 60_000);
        bars.Should().Contain(bar => !bar.Missing && bar.T == TestData.EpochMs + 180_000);
    }

    [Fact]
    public void MarkMissing_ShouldKeepTheNewestRanges_WhenAProfileFillsItsCap()
    {
        var engine = LiveEngine();
        var newest = 0L;
        for (var i = 0; i < VolumeProfile.MaxClosedRanges + 1; i++)
        {
            var since = TestData.EpochMs + (i * 2_000);
            newest = since;
            engine.MarkMissing(since);
            engine.Apply(Reset(since + 500, BookResetEvent.SubscribedReason));
            engine.Apply(TestData.Snapshot(since + 1_000) with { Resubscribe = true });
        }

        var ranges = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").MissingRanges;
        ranges.Should().HaveCount(VolumeProfile.MaxClosedRanges);
        ranges[0][0].Should().Be(TestData.EpochMs + 2_000);
        ranges[^1][0].Should().Be(newest);
        engine.MissingRangesDropped["session"].Should().Be(1);
        engine.MissingRangesDropped["1h"].Should().Be(1);
        engine.MissingRangesDropped["4h"].Should().Be(1);
        engine.MissingRangesDropped["5d"].Should().Be(1);
    }

    private static List<FootprintDto> Bars(InstrumentEngine engine)
    {
        var flow = engine.Snapshot(180, null).OrderFlow;
        var bars = flow.Footprints.ToList();
        if (flow.DevelopingFootprint is { } developing)
        {
            bars.Add(developing);
        }

        return bars;
    }

    private static BookResetEvent Reset(long timeMs, string reason) => new()
    {
        Root = Mes.Root,
        ContractId = Mes.ContractId,
        SourceTimeMs = timeMs,
        ReceivedTimeMs = timeMs,
        Epoch = 1,
        Sequence = 1,
        Reason = reason,
    };

    private static MarketIngestBuffer Buffer(int trades, int depth) => new(new IngestBufferOptions
    {
        TradeCapacity = trades,
        DepthLevelsPerContract = depth,
    });

    private static InstrumentEngine LiveEngine()
    {
        var engine = new InstrumentEngine(Mes, EngineOptions.Default, TestData.Calendar());
        engine.Apply(Status(0, connected: true));
        engine.Apply(TestData.Snapshot(TestData.EpochMs));
        engine.Status().Code.Should().Be("SIMULATED");
        return engine;
    }

    private static TradeEvent Trade(int sequence, InstrumentSpec spec, long quantity, string? tradeId = null) => new()
    {
        Root = spec.Root,
        ContractId = spec.ContractId,
        SourceTimeMs = TestData.EpochMs + sequence,
        ReceivedTimeMs = TestData.EpochMs + sequence,
        Epoch = 1,
        Sequence = sequence,
        PriceTicks = 24_000,
        Quantity = quantity,
        Aggressor = BookSide.Bid,
        TradeId = tradeId ?? $"T-{spec.Root}-{sequence}",
    };

    private static DepthUpdateEvent Depth(int sequence, long price, long quantity) => new()
    {
        Root = Mes.Root,
        ContractId = Mes.ContractId,
        SourceTimeMs = TestData.EpochMs + sequence,
        ReceivedTimeMs = TestData.EpochMs + sequence,
        Epoch = 1,
        Sequence = sequence,
        Side = BookSide.Bid,
        PriceTicks = price,
        Quantity = quantity,
    };

    private static QuoteEvent Quote(int sequence) => new()
    {
        Root = Mes.Root,
        ContractId = Mes.ContractId,
        SourceTimeMs = TestData.EpochMs + sequence,
        ReceivedTimeMs = TestData.EpochMs + sequence,
        Epoch = 1,
        Sequence = sequence,
        BidTicks = 24_000,
        AskTicks = 24_001,
    };

    private static FeedStatusEvent Status(int sequence, bool connected) => new()
    {
        Root = Mes.Root,
        ContractId = Mes.ContractId,
        SourceTimeMs = TestData.EpochMs + sequence,
        ReceivedTimeMs = TestData.EpochMs + sequence,
        Epoch = 1,
        Sequence = sequence,
        Connected = connected,
        Provenance = FeedProvenance.Simulated,
        DepthSubscribed = true,
    };

    private static BookResetEvent Reset(int sequence) => new()
    {
        Root = Mes.Root,
        ContractId = Mes.ContractId,
        SourceTimeMs = TestData.EpochMs + sequence,
        ReceivedTimeMs = TestData.EpochMs + sequence,
        Epoch = 1,
        Sequence = sequence,
        Reason = "gateway reset",
    };
}
