using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Levels;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Engine;

// reference: ARCHITECTURE.md D-33
public sealed class GapRepairTests
{
    private const long Px = TestData.EsBase;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void ApplyApproximateMinutes_ShouldWriteTheGapMinuteInPlace_WhenTheLiveCursorIsAhead()
    {
        var engine = Live();
        engine.Apply(Print(T0 + 1_000, Px, 2, "live-0"));
        engine.Tick(T0 + 180_000);
        Heartbeat(engine, T0 + 180_000);
        var lastMs = engine.Summary().LastTradeMs;
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();

        var result = engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 4), Bar(T0 + 120_000, 15, Px + 6)]);

        result.Completed.Should().BeFalse("the hole is still open, so the bar covering its end cannot exist yet");
        result.MinutesWritten.Should().Be(2);
        engine.Summary().Last.Should().Be(Px);
        engine.Summary().LastTradeMs.Should().Be(lastMs);
        engine.Status().Code.Should().Be("DEGRADED");
        engine.Status().CvdKnown.Should().BeFalse();
        engine.Status().Approximate.Should().BeTrue();
        Minute(engine, T0 + 60_000).V.Should().Be(40);
        Minute(engine, T0 + 120_000).V.Should().Be(15);
        engine.Snapshot(60, null).DevelopingMinute.Should().BeNull("the forming minute was not pulled back onto the repaired bin");
        var footprint = engine.Snapshot(60, null).OrderFlow.Footprints.Single(bar => bar.T == T0 + 60_000);
        footprint.Approximate.Should().BeTrue();
        footprint.Missing.Should().BeFalse();
        footprint.V.Should().Be(40);
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldFoldAReplacedMinuteIntoTheFourHourMid_WhenTheHoleAlreadyClosedAnEmptyMinute()
    {
        var engine = Live();
        engine.Apply(Print(T0 + 1_000, Px, 1, "live"));
        engine.Tick(T0 + 180_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();

        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 4)]);

        var mid = engine.Snapshot(60, null).OrderFlow.KeyLevels.Should().ContainSingle(level => level.Name == RipsLevelNames.FourHourMid).Subject;
        mid.PriceTicks.Should().Be(RipsLevels.Mid(Px + 8, Px - 4));
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldStayIncomplete_WhenTheBarCoveringTheEndIsMissing()
    {
        var engine = Prepared(T0 + 300_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 180_000);

        var partial = engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 9, Px + 1)]);

        partial.Completed.Should().BeFalse();
        partial.MinutesWritten.Should().BeGreaterThan(0);
        engine.Status().Code.Should().Be("DEGRADED");
        engine.Status().CvdKnown.Should().BeTrue("the resubscribe anchors CVD; the repair does not decide that");

        var done = engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 9, Px + 1), Bar(T0 + 120_000, 11, Px + 2)]);

        done.Completed.Should().BeTrue();
        done.MinutesWritten.Should().Be(1, "the first minute was already filled; only the end minute is new");
        Minute(engine, T0 + 120_000).V.Should().Be(11);
        engine.Status().Code.Should().Be("DEGRADED");
        engine.Status().Code.Should().NotBe("SIMULATED");
        engine.Status().Approximate.Should().BeTrue();
        engine.Summary().Last.Should().Be(Px);
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldStopAtTheExchangeResume_WhenAQueuedTradeCarriesALaterReceiveTime()
    {
        var engine = Live();
        engine.Apply(Print(T0 + 1_000, Px, 2, "before"));
        engine.MarkMissing(T0 + 60_000);
        engine.Apply(Print(T0 + 150_000, Px + 3, 7, "queued") with { ReceivedTimeMs = T0 + 400_000 });

        var result = engine.ApplyApproximateMinutes(
        [
            Bar(T0 + 60_000, 40, Px + 9),
            Bar(T0 + 120_000, 99, Px + 9),
        ]);

        result.MinutesWritten.Should().Be(1);
        Minute(engine, T0 + 60_000).V.Should().Be(40);
        var forming = engine.Snapshot(60, null).DevelopingMinute;
        forming.Should().NotBeNull();
        forming!.T.Should().Be(T0 + 120_000);
        forming.V.Should().Be(7, "the live print's exchange time is inside this minute, so the bar must not be added");
        engine.Summary().Last.Should().Be(Px + 3);
        engine.Summary().LastTradeMs.Should().Be(T0 + 150_000);
    }

    [Fact]
    public void Apply_ShouldLeaveTheRepairedMinuteAndTheLaterPrice_WhenAQueuedPrintFallsInsideIt()
    {
        var engine = Prepared(T0 + 180_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 8)]);
        engine.Apply(Print(T0 + 200_000, Px + 5, 3, "later"));

        engine.Apply(Print(T0 + 90_000, Px - 20, 6, "late-old") with { ReceivedTimeMs = T0 + 250_000 });

        engine.Summary().Last.Should().Be(Px + 5);
        engine.Summary().LastTradeMs.Should().Be(T0 + 200_000);
        Minute(engine, T0 + 60_000).V.Should().Be(40);
        engine.Snapshot(60, null).DevelopingMinute!.V.Should().Be(3);
        engine.Snapshot(60, null).DevelopingMinute!.T.Should().Be(T0 + 180_000);
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldFillTheEarlierMinute_WhenASecondGapMergesBackward()
    {
        var engine = Prepared(T0 + 300_000);
        engine.MarkMissing(T0 + 120_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 240_000);

        var result = engine.ApplyApproximateMinutes(
        [
            Bar(T0 + 60_000, 4, Px + 1),
            Bar(T0 + 120_000, 5, Px + 1),
            Bar(T0 + 180_000, 6, Px + 1),
        ]);

        result.Completed.Should().BeTrue();
        Minute(engine, T0 + 60_000).V.Should().Be(4);
        Minute(engine, T0 + 180_000).V.Should().Be(6);
        engine.Status().MissingSinceMs.Should().BeNull();
        engine.Status().Code.Should().Be("DEGRADED");
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldKeepBothHoles_WhenTheSecondGapStartsAfterTheFirst()
    {
        var engine = Live();
        engine.Apply(Print(T0 + 1_000, Px, 2, "seed"));
        engine.Tick(T0 + 150_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 120_000);
        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 4, Px + 1)]).Completed.Should().BeTrue();

        engine.Apply(Print(T0 + 200_000, Px + 2, 1, "between"));
        engine.Tick(T0 + 360_000);
        engine.MarkMissing(T0 + 240_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 300_000);
        Heartbeat(engine, T0 + 360_000);
        var second = engine.ApplyApproximateMinutes([Bar(T0 + 240_000, 8, Px + 3)]);

        second.Completed.Should().BeTrue();
        Minute(engine, T0 + 60_000).V.Should().Be(4);
        Minute(engine, T0 + 240_000).V.Should().Be(8);
        Minute(engine, T0 + 180_000).V.Should().Be(1);
        var approximate = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").ApproximateRanges;
        approximate.Should().HaveCount(2);
        engine.Summary().Last.Should().Be(Px + 2);
        engine.Status().Code.Should().Be("DEGRADED");
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldLeaveThePartialMinute_WhenTheGapStartsInsideIt()
    {
        var engine = Live();
        engine.Apply(Print(T0 + 61_000, Px, 3, "inside"));
        engine.Tick(T0 + 300_000);
        engine.MarkMissing(T0 + 65_000);
        Resubscribe(engine, T0 + 180_000);

        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 50, Px + 4), Bar(T0 + 120_000, 20, Px + 4)]);

        Minute(engine, T0 + 60_000).V.Should().Be(3);
        Minute(engine, T0 + 120_000).V.Should().Be(20);
        engine.Summary().Last.Should().Be(Px);
    }

    [Fact]
    public void Publish_ShouldSendARepairedMinuteBehindTheWatermark_WhenTheClientAlreadyMovedOn()
    {
        var engine = Live();
        engine.Apply(Print(T0 + 1_000, Px, 1, "first"));
        engine.Apply(Print(T0 + 130_000, Px + 2, 2, "second"));
        engine.Tick(T0 + 200_000);
        engine.Publish(null);
        engine.MarkMissing(T0 + 60_000);

        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 7)]);
        var delta = engine.Publish(null);

        delta.MinuteBars.Should().Contain(bar => bar.T == T0 + 60_000 && bar.V == 40);
        delta.OrderFlow.Footprints.Should().Contain(bar => bar.T == T0 + 60_000 && bar.Approximate && bar.V == 40);
        engine.Summary().Last.Should().Be(Px + 2);
        engine.Summary().LastTradeMs.Should().Be(T0 + 130_000);
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldFillTheEmptyMinute_WhenTheDropStartsInsideIt()
    {
        var engine = Prepared(T0 + 300_000);
        engine.MarkMissing(T0 + 65_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 180_000);

        var result = engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 4)]);

        result.MinutesWritten.Should().Be(1);
        Minute(engine, T0 + 60_000).V.Should().Be(40);
        var footprint = engine.Snapshot(60, null).OrderFlow.Footprints.Single(bar => bar.T == T0 + 60_000);
        footprint.Approximate.Should().BeTrue();
        footprint.V.Should().Be(40);
        var session = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session");
        session.Total.Should().Be(42);
        session.Bins.Should().Contain(bin => bin[0] == Px + 4 && bin[1] > 0);
        session.ApproximateRanges.Should().NotBeEmpty();
        engine.Summary().Last.Should().Be(Px);
    }

    [Fact]
    public void Apply_ShouldLeaveTheFormingBar_WhenALatePrintLandsInsideAnUnfinishedHole()
    {
        var engine = Prepared(T0 + 300_000);
        engine.MarkMissing(T0 + 60_000);
        engine.Apply(Print(T0 + 70_000, Px + 3, 9, "stale") with { ReceivedTimeMs = T0 + 300_000 });

        engine.Snapshot(60, null).DevelopingMinute.Should().BeNull();
        engine.Summary().Last.Should().Be(Px + 3);
        engine.Summary().SessionVolume.Should().Be(2);

        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 1), Bar(T0 + 120_000, 15, Px + 1)]);

        Minute(engine, T0 + 120_000).V.Should().Be(15);
        engine.Snapshot(60, null).DevelopingMinute.Should().BeNull();
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldIgnoreAPreSessionHole_WhenTheRepairFinishesAfterTheRoll()
    {
        var engine = Prepared(T0 + 120_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();
        var nextOpen = T0 + (9 * 60 * 60 * 1000);
        engine.Apply(Print(nextOpen, Px + 1, 3, "next-session"));
        Heartbeat(engine, nextOpen);

        var result = engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 9)]);

        result.MinutesWritten.Should().Be(0);
        var session = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session");
        session.Total.Should().Be(3);
        session.ApproximateRanges.Should().BeEmpty();
        engine.Snapshot(60, null).Vwap.Volume.Should().Be(3);
        engine.Summary().SessionVolume.Should().Be(3);
        engine.Status().Code.Should().Be("SIMULATED");
        engine.TakeRepairKick().Should().BeFalse("the previous session's hole was dropped, so nothing is left to repair");
    }

    [Fact]
    public void Status_ShouldLeaveDegraded_WhenOnlyARollingProfileStillHoldsTheRepair()
    {
        var engine = Prepared(T0 + 300_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 120_000);
        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 4)]).Completed.Should().BeTrue();
        engine.Status().Code.Should().Be("DEGRADED");

        var nextOpen = T0 + (9 * 60 * 60 * 1000);
        engine.Apply(Print(nextOpen, Px + 1, 1, "rolled"));
        Heartbeat(engine, nextOpen);

        var profiles = engine.Snapshot(60, null).Profiles;
        profiles.Single(profile => profile.Window == "session").ApproximateRanges.Should().BeEmpty();
        profiles.Single(profile => profile.Window == "5d").ApproximateRanges.Should().NotBeEmpty();
        engine.Status().Code.Should().Be("SIMULATED");
        engine.Status().Approximate.Should().BeFalse();
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldFillLaterEmptyMinutes_WhenLiveResumeIsInsideTheFirstMinute()
    {
        var engine = Live();
        engine.Apply(Print(T0 + 1_000, Px, 2, "before"));
        engine.MarkMissing(T0 + 60_000);
        engine.Apply(Print(T0 + 70_000, Px + 1, 4, "resume"));
        engine.Tick(T0 + 300_000);
        Heartbeat(engine, T0 + 300_000);
        Resubscribe(engine, T0 + 300_000);
        engine.TakeRepairKick().Should().BeTrue();
        engine.TakeRepairKick().Should().BeFalse();

        var result = engine.ApplyApproximateMinutes(
        [
            Bar(T0 + 60_000, 40, Px + 4),
            Bar(T0 + 120_000, 11, Px + 4),
            Bar(T0 + 180_000, 12, Px + 4),
            Bar(T0 + 240_000, 13, Px + 4),
        ]);

        result.Completed.Should().BeTrue();
        result.MinutesWritten.Should().Be(3);
        Minute(engine, T0 + 60_000).V.Should().Be(4, "the live print in this minute is not replaced");
        Minute(engine, T0 + 120_000).V.Should().Be(11);
        Minute(engine, T0 + 180_000).V.Should().Be(12);
        Minute(engine, T0 + 240_000).V.Should().Be(13);
        engine.Summary().Last.Should().Be(Px + 1);
        engine.Summary().LastTradeMs.Should().Be(T0 + 70_000);
        engine.Status().Code.Should().Be("DEGRADED");
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldKeepFootprintDeltaWithinOneLot_WhenTheClosedBarVolumeIsOdd()
    {
        var engine = Prepared(T0 + 300_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 180_000);
        var cvd = engine.Snapshot(60, null).OrderFlow.Cvd;

        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 5, Px + 1), Bar(T0 + 120_000, 5, Px + 1)]);

        var footprint = engine.Snapshot(60, null).OrderFlow.Footprints.Single(bar => bar.T == T0 + 60_000);
        footprint.Approximate.Should().BeTrue();
        footprint.V.Should().Be(5);
        footprint.Delta.Should().BeInRange(-1, 1);
        var minute = Minute(engine, T0 + 60_000);
        minute.O.Should().Be(Px - 2);
        minute.H.Should().Be(Px + 8);
        minute.L.Should().Be(Px - 4);
        minute.C.Should().Be(Px + 1);
        minute.V.Should().Be(5);
        Math.Abs(minute.Bv - minute.Sv).Should().BeLessThanOrEqualTo(1);
        engine.Snapshot(60, null).OrderFlow.Cvd.Should().Be(cvd);
    }

    [Fact]
    public void ApplyApproximateMinutes_ShouldLeaveIndicatorsHeatAndSecondBars_WhenTheGapMinuteIsRepaired()
    {
        var engine = Prepared(T0 + 300_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 180_000);
        var before = engine.Snapshot(60, null);

        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 4), Bar(T0 + 120_000, 11, Px + 2)]);

        var after = engine.Snapshot(60, null);
        after.Indicators.Should().BeEquivalentTo(before.Indicators);
        after.Bars.Should().BeEquivalentTo(before.Bars);
        after.MinuteHeat.Should().BeEquivalentTo(before.MinuteHeat);
        after.DevelopingMinuteHeat.Should().BeEquivalentTo(before.DevelopingMinuteHeat);
        Minute(engine, T0 + 60_000).V.Should().Be(40);
        after.OrderFlow.Footprints.Should().Contain(bar => bar.T == T0 + 60_000 && bar.Approximate);
    }

    [Fact]
    public void Apply_ShouldIgnoreALatePrint_WhenTheRepairedMinuteHasLeftTheHistoryWindow()
    {
        var options = EngineOptions.Default with { HistoryRetentionMinutes = 2 };
        var engine = new InstrumentEngine(InstrumentCatalog.MES, options, TestData.Calendar());
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));
        engine.Apply(Print(T0 + 1_000, Px, 2, "seed"));
        engine.Tick(T0 + 300_000);
        Heartbeat(engine, T0 + 300_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 180_000);
        engine.ApplyApproximateMinutes([Bar(T0 + 60_000, 40, Px + 4), Bar(T0 + 120_000, 11, Px + 2)]).Completed.Should().BeTrue();
        var volume = engine.Summary().SessionVolume;

        engine.Tick(T0 + 360_000);
        Heartbeat(engine, T0 + 360_000);
        engine.Apply(Print(T0 + 90_000, Px - 30, 6, "late-trimmed") with { ReceivedTimeMs = T0 + 360_000 });

        engine.Summary().SessionVolume.Should().Be(volume);
        engine.Summary().Last.Should().Be(Px - 30);
        engine.Summary().LastTradeMs.Should().Be(T0 + 90_000);
        engine.Snapshot(60, null).MinuteBars.Should().NotContain(bar => bar.T == T0 + 60_000 && bar.V == 6);
    }

    [Fact]
    public void CloseOpenGap_ShouldNotExtendPastAGoodResubscribe_WhenALaterDropIsFarAhead()
    {
        var engine = Prepared(T0 + 300_000);
        var since = T0 + 30_000;
        var close = T0 + 60_000;
        var far = close + InstrumentEngine.MaxClockAheadMs + 60_000;
        engine.MarkMissing(since);
        engine.MarkMissing(far);
        Resubscribe(engine, close);

        var until = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").MissingRanges.Single()[1];
        until.Should().Be(close);
        until.Should().BeLessThan(far);

        var window = engine.NextRepairWindow(T0 + 300_000);
        window.Pending.Should().BeTrue();
        window.ToMs.Should().BeLessThan(far);
        window.ToMs.Should().Be(T0 + 60_000);
    }

    [Fact]
    public void CloseOpenGap_ShouldIncludeTheLaterDrop_WhenItIsInsideTheCloseClock()
    {
        var engine = Prepared(T0 + 300_000);
        var since = T0 + 30_000;
        var through = T0 + 70_000;
        var close = T0 + 50_000;
        engine.MarkMissing(since);
        engine.MarkMissing(through);
        engine.Apply(new FeedStatusEvent
        {
            Root = InstrumentRoot.MES,
            ContractId = InstrumentCatalog.MES.ContractId,
            SourceTimeMs = close,
            ReceivedTimeMs = close,
            Epoch = 2,
            Sequence = 1,
            Connected = true,
            Provenance = FeedProvenance.Simulated,
            DepthSubscribed = false,
        });

        var until = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "1h").MissingRanges.Single()[1];
        until.Should().Be(through + 1);
    }

    [Fact]
    public void MarkMissing_ShouldKeepALaterHole_WhenTheNewStartDoesNotTouchIt()
    {
        var engine = Prepared(T0 + 360_000);
        engine.MarkMissing(T0 + 240_000);
        Resubscribe(engine, T0 + 300_000);
        engine.MarkMissing(T0 + 60_000);
        Resubscribe(engine, T0 + 120_000);

        var starts = engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").MissingRanges
            .Select(range => range[0]);
        starts.Should().BeEquivalentTo([T0 + 240_000, T0 + 60_000]);
    }

    [Fact]
    public void ArmGapRepair_ShouldStayDegradedAfterTheChipClears_WhenTheBarsHaveNotArrived()
    {
        var engine = Prepared(T0 + 120_000);
        engine.MarkMissing(T0 + 60_000);
        engine.ArmGapRepair();
        Resubscribe(engine, T0 + 90_000);

        engine.Status().MissingSinceMs.Should().BeNull();
        engine.Status().CvdKnown.Should().BeTrue();
        engine.Status().Code.Should().Be("DEGRADED");
        engine.Status().Approximate.Should().BeFalse();
    }

    private static InstrumentEngine Live()
    {
        var engine = new InstrumentEngine(InstrumentCatalog.MES, EngineOptions.Default, TestData.Calendar());
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));
        return engine;
    }

    private static InstrumentEngine Prepared(long tickMs)
    {
        var engine = Live();
        engine.Apply(Print(T0 + 1_000, Px, 2, "seed"));
        engine.Tick(tickMs);
        Heartbeat(engine, tickMs);
        return engine;
    }

    private static void Heartbeat(InstrumentEngine engine, long timeMs) =>
        engine.Apply(TestData.Status(timeMs, connected: true));

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

    private static TradeEvent Print(long timeMs, long price, long quantity, string id) =>
        TestData.Trade(timeMs, price, quantity, BookSide.Bid, id);

    private static HistoricalMinuteBar Bar(long startMs, long volume, long close) =>
        new(startMs, Px - 2, Px + 8, Px - 4, close, volume);

    private static BarDto Minute(InstrumentEngine engine, long startMs) =>
        engine.Snapshot(60, null).MinuteBars.Should().ContainSingle(bar => bar.T == startMs).Subject;
}
