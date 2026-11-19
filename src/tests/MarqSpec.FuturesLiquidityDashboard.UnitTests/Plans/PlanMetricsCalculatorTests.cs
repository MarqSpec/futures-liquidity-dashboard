using MarqSpec.FuturesLiquidityDashboard.Core.Heatmap;
using MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;
using MarqSpec.FuturesLiquidityDashboard.Core.Regime;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Plans;

// reference: REQUIREMENTS.md FR-73, FR-11, FR-12, FR-21, FR-37, FR-40, FR-42; ARCHITECTURE.md D-60
// Every price is an invented tick key around 1000; nothing here is market data.
public sealed class PlanMetricsCalculatorTests
{
    private const long Minute = 60_000;

    // A minute boundary plus 30 s, so the window of minute slots ends at AnchorMs.
    private static readonly long AnchorMs = TestData.EpochMs - (TestData.EpochMs % Minute) + (240 * Minute);
    private static readonly long AsOfMs = AnchorMs + 30_000;

    private static readonly PlanSpec LongLimit = new(true, false, 996, 2, 992, [new PlanTarget(1004, 1), new PlanTarget(1008, 1)]);
    private static readonly PlanSpec ShortLimit = new(false, false, 1004, 1, 1008, [new PlanTarget(996, 1)]);
    private static readonly PlanSpec LongMarket = new(true, true, null, 8, 994, [new PlanTarget(1006, 8)]);
    private static readonly PlanSpec ShortMarket = new(false, true, null, 12, 1006, [new PlanTarget(994, 12)]);

    [Fact]
    public void Compute_ShouldGiveSignedDistanceInTicksAndAtr_WhenTheLastPriceAndAtrAreKnown()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market());

        var entry = metrics.Legs[0];
        (entry.Leg, entry.PriceTicks, entry.DistanceTicks, entry.DistanceAtr).Should().Be(("entry", 996L, -4L, -1.0));
        metrics.Legs.Select(l => (l.Leg, l.Index, l.DistanceTicks)).Should().Equal(
            ("entry", null, -4L), ("stop", null, -8L), ("target", 0, 4L), ("target", 1, 8L));
    }

    [Fact]
    public void Compute_ShouldGiveNoDistance_WhenThereIsNoLastPrice()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market() with { LastTicks = null });

        var entry = metrics.Legs[0];
        (entry.DistanceTicks, entry.DistanceAtr, entry.DistanceReason).Should().Be((null, null, UnknownReasons.NoLastPrice));
    }

    [Fact]
    public void Compute_ShouldGiveDistanceInTicksButNotInAtr_WhenAtrIsUnknown()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market() with { AtrTicks = null });

        var entry = metrics.Legs[0];
        (entry.DistanceTicks, entry.DistanceAtr).Should().Be((-4L, null));
    }

    [Fact]
    public void Compute_ShouldGiveRewardRiskPerTargetAndStopAtr_WhenTheEntryIsALongLimit()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market());

        metrics.RewardRisk.Select(r => (r.Index, r.TargetTicks, r.Ratio)).Should().Equal((0, 1004L, 2.0), (1, 1008L, 3.0));
        metrics.StopAtr.Should().Be(1.0);
    }

    [Fact]
    public void Compute_ShouldGiveRewardRiskAndStopAtr_WhenTheEntryIsAShortLimit()
    {
        var metrics = PlanMetricsCalculator.Compute(ShortLimit, Market());

        metrics.RewardRisk.Single().Ratio.Should().Be(2.0);
        metrics.StopAtr.Should().Be(1.0);
    }

    [Fact]
    public void Compute_ShouldMeasureRewardRiskFromTheLastPrice_WhenAMarketEntryHasNoPrice()
    {
        var metrics = PlanMetricsCalculator.Compute(LongMarket, Market());

        // Last 1000, stop 994, target 1006: risk 6, reward 6.
        metrics.Legs[0].PriceTicks.Should().Be(1000);
        metrics.RewardRisk.Single().Ratio.Should().Be(1.0);
        metrics.StopAtr.Should().Be(1.5);
    }

    [Fact]
    public void Compute_ShouldGiveNoRewardRisk_WhenAMarketEntryHasNoPriceAndNoLastPrice()
    {
        var metrics = PlanMetricsCalculator.Compute(LongMarket, Market() with { LastTicks = null });

        metrics.RewardRisk.Single().Should().Be(new RewardRisk(0, 1006, null, UnknownReasons.NoReferencePrice));
        (metrics.StopAtr, metrics.StopAtrReason).Should().Be((null, UnknownReasons.NoReferencePrice));
    }

    [Fact]
    public void Compute_ShouldGiveNoRewardRisk_WhenTheLastPriceIsAlreadyBeyondAMarketEntrysStop()
    {
        var metrics = PlanMetricsCalculator.Compute(LongMarket, Market() with { LastTicks = 993 });

        metrics.RewardRisk.Single().Reason.Should().Be(UnknownReasons.NoRisk);
    }

    [Fact]
    public void Compute_ShouldGiveNoStopAtr_WhenAtrIsUnknown()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market() with { AtrTicks = null });

        (metrics.StopAtr, metrics.StopAtrReason).Should().Be((null, UnknownReasons.AtrUnknown));
    }

    [Fact]
    public void Compute_ShouldReadTheBidNowAndItsTenMinuteMean_WhenTheLegIsALongLimitEntry()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market());

        metrics.Legs[0].RestingAhead.Should().Be(new RestingSize("bid", 10, null, 12.0, null, 1.0, false));
    }

    [Fact]
    public void Compute_ShouldReadTheAskAtEachTarget_WhenThePlanIsLong()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market());

        metrics.Legs[2].RestingAhead!.Side.Should().Be("ask");
        metrics.Legs[2].RestingAhead!.Now.Should().Be(8);
    }

    [Fact]
    public void Compute_ShouldReadTheAskAtTheEntryAndTheBidAtTheTarget_WhenThePlanIsAShortLimit()
    {
        var metrics = PlanMetricsCalculator.Compute(ShortLimit, Market());

        (metrics.Legs[0].RestingAhead!.Side, metrics.Legs[0].RestingAhead!.Now).Should().Be(("ask", 8L));
        (metrics.Legs[2].RestingAhead!.Side, metrics.Legs[2].RestingAhead!.Now).Should().Be(("bid", 10L));
    }

    [Fact]
    public void Compute_ShouldGiveNoRestingSize_WhenTheLegIsTheStopOrAMarketEntry()
    {
        PlanMetricsCalculator.Compute(LongLimit, Market()).Legs[1].RestingAhead.Should().BeNull();
        PlanMetricsCalculator.Compute(LongMarket, Market()).Legs[0].RestingAhead.Should().BeNull();
    }

    [Fact]
    public void Compute_ShouldGiveUnknownRestingSizeNotZero_WhenTheBookIsUnknown()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market() with { Book = PlanBook.Unknown });

        var resting = metrics.Legs[0].RestingAhead!;
        (resting.Now, resting.NowReason).Should().Be((null, UnknownReasons.BookUnknown));
    }

    [Fact]
    public void Compute_ShouldGiveUnknownRestingSizeNotZero_WhenTheLegIsOutsideTheCoveredDepth()
    {
        var plan = LongLimit with { EntryTicks = 980, StopTicks = 976 };

        var resting = PlanMetricsCalculator.Compute(plan, Market()).Legs[0].RestingAhead!;

        (resting.Now, resting.NowReason).Should().Be((null, UnknownReasons.OutsideCoveredDepth));
    }

    [Fact]
    public void Compute_ShouldGiveUnknownRestingSize_WhenTheLevelItselfIsUnknownInsideCoverage()
    {
        var book = Book() with { Cells = [.. Book().Cells.Select(c => c.PriceTicks == 996 ? c with { Bid = null } : c)] };

        var resting = PlanMetricsCalculator.Compute(LongLimit, Market() with { Book = book }).Legs[0].RestingAhead!;

        (resting.Now, resting.NowReason).Should().Be((null, UnknownReasons.LevelUnknown));
    }

    [Fact]
    public void Compute_ShouldFlagThePartialTenMinuteMeanWithItsCoverage_WhenHalfTheWindowWasKnown()
    {
        var heat = Slices(AsOfMs, 600, 996, bid: 12, knownMs: 500);

        var resting = PlanMetricsCalculator.Compute(LongLimit, Market() with { RecentHeat = heat }).Legs[0].RestingAhead!;

        (resting.Mean10m, resting.Coverage10m, resting.Partial).Should().Be((12.0, 0.5, true));
    }

    [Fact]
    public void Compute_ShouldGiveNoTenMinuteMeanNotZero_WhenNoMillisecondAtThePriceWasKnown()
    {
        var resting = PlanMetricsCalculator.Compute(LongLimit, Market() with { RecentHeat = [] }).Legs[0].RestingAhead!;

        (resting.Mean10m, resting.Mean10mReason, resting.Coverage10m, resting.Partial).Should().Be((null, UnknownReasons.NoKnownTime, 0.0, true));
    }

    [Fact]
    public void Compute_ShouldIgnoreHeatOlderThanTenMinutes_WhenAveragingRestingSize()
    {
        // The slice that closed just before the ten minutes began holds a very different size.
        var heat = new[] { new HeatmapColumn(AsOfMs - 601_000, 1_000, [new HeatCell(996, 900.0 * 1_000, 0, 1_000)]) }
            .Concat(Slices(AsOfMs, 600, 996, bid: 12))
            .ToList();

        var resting = PlanMetricsCalculator.Compute(LongLimit, Market() with { RecentHeat = heat }).Legs[0].RestingAhead!;

        resting.Mean10m.Should().Be(12.0);
    }

    [Fact]
    public void Compute_ShouldCountTheLastSixHundredClosedSlicesAsComplete_WhenTheReadFallsBetweenSliceBoundaries()
    {
        // A live read lands mid-slice: 437 ms after the last closed one-second slice ended.
        var market = Market() with { AsOfMs = AsOfMs + 437, RecentHeat = Slices(AsOfMs, 600, 996, bid: 12) };

        var resting = PlanMetricsCalculator.Compute(LongLimit, market).Legs[0].RestingAhead!;

        (resting.Mean10m, resting.Coverage10m, resting.Partial).Should().Be((12.0, 1.0, false));
    }

    [Fact]
    public void Compute_ShouldCountOnlyBarsThatTradedStrictlyBelowTheEntry_WhenTheEntryIsALongLimit()
    {
        // 60 bars: 6 with a low under 996, 4 whose low touches 996 exactly, the rest above it.
        var minutes = Minutes(60, i => i < 6 ? (1000, 995) : i < 10 ? (1000, 996) : (1001, 997));

        var frequency = PlanMetricsCalculator.Compute(LongLimit, Market() with { Minutes = minutes }).Legs[0].ThroughFrequency[0];

        frequency.Should().Be(new ThroughFrequency(60, "below", 60, 6, 0.1, 1.0, false));
    }

    [Fact]
    public void Compute_ShouldCountOnlyBarsThatTradedStrictlyAboveTheTarget_WhenThePlanIsLong()
    {
        // Target 1004: 3 highs above it, 5 exactly at it.
        var minutes = Minutes(60, i => i < 3 ? (1005, 1000) : i < 8 ? (1004, 1000) : (1002, 999));

        var frequency = PlanMetricsCalculator.Compute(LongLimit, Market() with { Minutes = minutes }).Legs[2].ThroughFrequency[0];

        (frequency.Direction, frequency.Through, frequency.Share).Should().Be(("above", 3, 0.05));
    }

    [Fact]
    public void Compute_ShouldLookAboveTheShortEntryAndStopAndBelowItsTarget_WhenThePlanIsShort()
    {
        var metrics = PlanMetricsCalculator.Compute(ShortLimit, Market());

        metrics.Legs.Select(l => l.ThroughFrequency[0].Direction).Should().Equal("above", "above", "below");
    }

    [Fact]
    public void Compute_ShouldFlagTheLongWindowWithItsCoverage_WhenOnlySixtyMinutesOfBarsExist()
    {
        var minutes = Minutes(60, i => i < 6 ? (1000, 995) : (1001, 997));

        var windows = PlanMetricsCalculator.Compute(LongLimit, Market() with { Minutes = minutes }).Legs[0].ThroughFrequency;

        windows.Select(w => w.Bars).Should().Equal(60, 240);
        windows[1].Should().Be(new ThroughFrequency(240, "below", 60, 6, 0.1, 0.25, true));
    }

    [Fact]
    public void Compute_ShouldLeaveMissingMinutesOutOfTheCount_WhenTradesWereDropped()
    {
        var minutes = Minutes(60, i => i < 6 ? (1000, 995) : (1001, 997)).Select((m, i) => i < 3 ? m with { Missing = true } : m).ToList();

        var frequency = PlanMetricsCalculator.Compute(LongLimit, Market() with { Minutes = minutes }).Legs[0].ThroughFrequency[0];

        (frequency.Known, frequency.Through, frequency.Partial).Should().Be((57, 3, true));
    }

    [Fact]
    public void Compute_ShouldGiveNoShareNotZero_WhenNoMinuteIsKnown()
    {
        var frequency = PlanMetricsCalculator.Compute(LongLimit, Market() with { Minutes = [] }).Legs[0].ThroughFrequency[0];

        (frequency.Known, frequency.Share, frequency.Coverage).Should().Be((0, null, 0.0));
    }

    [Fact]
    public void Compute_ShouldGiveTheStartOfTheNewestBarThatReachedThePrice_WhenPriceWasLastThere()
    {
        // Bar i starts at AnchorMs - (60 - i) minutes; bars 0–9 reach 996, so bar 9 is the newest.
        var minutes = Minutes(60, i => i < 10 ? (1000, 996) : (1001, 997));

        var leg = PlanMetricsCalculator.Compute(LongLimit, Market() with { Minutes = minutes }).Legs[0];

        leg.LastReachedMs.Should().Be(AnchorMs - (51 * Minute));
    }

    [Fact]
    public void Compute_ShouldListWallsIcebergsSpoofsAndSweepsBetweenTheLastPriceAndTheLeg_WhenTheyAreInRange()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market());

        metrics.Legs[0].InTheWay.Items.Should().BeEquivalentTo(new[]
        {
            new InTheWayItem("wall", "bid", 997, 997, 50, 120_000),
            new InTheWayItem("iceberg", "bid", 999, 999, 30, 90_000),
            new InTheWayItem("spoof", null, 998, 998, null, 60_000),
        });
        metrics.Legs[2].InTheWay.Items.Should().BeEquivalentTo(new[]
        {
            new InTheWayItem("wall", "ask", 1003, 1003, 40, 30_000),
            new InTheWayItem("sweep", null, 1002, 1002, null, 45_000),
        });
    }

    [Fact]
    public void Compute_ShouldReportWallsAsUnknownNotAbsent_WhenTheBookIsUnknown()
    {
        var market = Market() with { Book = PlanBook.Unknown, Walls = [] };

        var inTheWay = PlanMetricsCalculator.Compute(LongLimit, market).Legs[0].InTheWay;

        inTheWay.WallsKnown.Should().BeFalse();
    }

    [Fact]
    public void Compute_ShouldGiveNoItemsInTheWay_WhenThereIsNoLastPrice()
    {
        var inTheWay = PlanMetricsCalculator.Compute(LongLimit, Market() with { LastTicks = null }).Legs[0].InTheWay;

        (inTheWay.Items, inTheWay.ItemsReason).Should().Be((null, UnknownReasons.NoLastPrice));
    }

    [Fact]
    public void Compute_ShouldListKeyLevelsWithinTwoAtrInclusive_WhenAtrIsKnown()
    {
        var levels = PlanMetricsCalculator.Compute(LongLimit, Market()).Legs[0].KeyLevels;

        // Entry 996, two ATR = 8 ticks: VAL 990 and POC 1004 (exactly 8) are in, VWAP 1005 is not.
        levels.Should().BeEquivalentTo(new[]
        {
            new NearLevel("profile", "VAL", 990, -6),
            new NearLevel("profile", "POC", 1004, 8),
            new NearLevel("prior-session", "prior session low", 993, -3),
        });
    }

    [Fact]
    public void Compute_ShouldGiveNoKeyLevels_WhenAtrIsUnknown()
    {
        var leg = PlanMetricsCalculator.Compute(LongLimit, Market() with { AtrTicks = null }).Legs[0];

        (leg.KeyLevels, leg.KeyLevelsReason).Should().Be((null, UnknownReasons.AtrUnknown));
    }

    [Fact]
    public void Compute_ShouldGiveTheSessionDeltaAtThePriceAndTheFlowNearIt_WhenTheLegIsTheEntry()
    {
        var flow = PlanMetricsCalculator.Compute(LongLimit, Market()).Legs[0].Flow;

        flow.SessionDeltaAtPrice.Should().Be(-30);
        flow.Zones.Should().Equal(new NearZone("bullish", 993, 995));
        flow.UnfinishedAuctions.Should().Equal(new NearAuction(989, false, AnchorMs - (5 * Minute)));
        flow.Signals.Should().Equal(new NearSignal("trapped-traders", "bearish", 998, 998, 20_000));
    }

    [Fact]
    public void Compute_ShouldGiveNoSessionDeltaNotZero_WhenNothingTradedAtThePrice()
    {
        var flow = PlanMetricsCalculator.Compute(LongLimit, Market()).Legs[2].Flow;

        flow.SessionDeltaAtPrice.Should().BeNull();
    }

    [Fact]
    public void Compute_ShouldFlagTheStopJustInsideALevel_WhenALongStopIsTwoTicksAboveIt()
    {
        var placement = PlanMetricsCalculator.Compute(LongLimit, Market()).StopPlacement;

        // Stop 992: VAL 990 is two ticks under it. Prior session low 993 is above the stop, so it is not inside.
        placement.JustInside.Should().BeTrue();
        placement.Near.Should().Equal(new StopNear("profile", "VAL", 990, 2));
    }

    [Fact]
    public void Compute_ShouldNotFlagTheStop_WhenTheLevelIsThreeTicksAway()
    {
        var plan = LongLimit with { StopTicks = 993 };
        var market = Market() with { Levels = [new PlanLevel("profile", "VAL", 990)] };

        PlanMetricsCalculator.Compute(plan, market).StopPlacement.JustInside.Should().BeFalse();
    }

    [Fact]
    public void Compute_ShouldNotFlagTheStop_WhenItSitsExactlyOnTheLevel()
    {
        var market = Market() with { Levels = [new PlanLevel("profile", "VAL", 992)] };

        PlanMetricsCalculator.Compute(LongLimit, market).StopPlacement.JustInside.Should().BeFalse();
    }

    [Fact]
    public void Compute_ShouldFlagAShortStopJustUnderAWall_WhenTheWallIsOneTickAboveIt()
    {
        var market = Market() with { Levels = [], Walls = [new LiquidityWall(BookSide.Ask, 1009, 60, 1_000)] };

        var placement = PlanMetricsCalculator.Compute(ShortLimit, market).StopPlacement;

        placement.Near.Should().Equal(new StopNear("wall", "ask wall", 1009, 1));
    }

    [Fact]
    public void Compute_ShouldWalkTheAsksLevelByLevel_WhenALongMarketEntryTakesEightContracts()
    {
        var slippage = PlanMetricsCalculator.Compute(LongMarket, Market()).MarketSlippage;

        // 5 at 1000 and 3 at 1001: average 1000.375, 0.375 past the touch.
        slippage.Should().Be(new MarketSlippage(1000, 1000.375, 0.375, 1001, 2, null));
    }

    [Fact]
    public void Compute_ShouldWalkTheBidsLevelByLevel_WhenAShortMarketEntryTakesTwelveContracts()
    {
        var slippage = PlanMetricsCalculator.Compute(ShortMarket, Market()).MarketSlippage!;

        // 10 at 999 and 2 at 998: average 998.8333, 0.1667 past the touch.
        (slippage.TouchTicks, slippage.AverageTicks, slippage.SlippageTicks, slippage.WorstTicks, slippage.LevelsWalked)
            .Should().Be((999L, 998.8333, 0.1667, 998L, 2));
    }

    [Fact]
    public void Compute_ShouldGiveNoSlippage_WhenTheEntryIsALimit()
    {
        PlanMetricsCalculator.Compute(LongLimit, Market()).MarketSlippage.Should().BeNull();
    }

    [Fact]
    public void Compute_ShouldGiveUnknownSlippageNotZero_WhenTheBookIsUnknown()
    {
        var slippage = PlanMetricsCalculator.Compute(LongMarket, Market() with { Book = PlanBook.Unknown }).MarketSlippage;

        slippage.Should().Be(new MarketSlippage(null, null, null, null, 0, UnknownReasons.BookUnknown));
    }

    [Fact]
    public void Compute_ShouldGiveUnknownSlippage_WhenTheWalkRunsPastTheCoveredDepth()
    {
        // Five at each covered ask from 1000 to 1010 is 55 contracts; the walk needs 100.
        var plan = LongMarket with { Quantity = 100, Targets = [new PlanTarget(1006, 1)] };
        var book = Book() with { Cells = [.. Book().Cells.Select(c => c.PriceTicks >= 1000 ? c with { Ask = 5 } : c)] };

        var slippage = PlanMetricsCalculator.Compute(plan, Market() with { Book = book }).MarketSlippage!;

        (slippage.SlippageTicks, slippage.Reason).Should().Be((null, UnknownReasons.OutsideCoveredDepth));
    }

    [Fact]
    public void Compute_ShouldGiveUnknownSlippage_WhenTheWalkReachesAnUnknownLevel()
    {
        var book = Book() with { Cells = [.. Book().Cells.Select(c => c.PriceTicks == 1001 ? c with { Ask = null } : c)] };

        var slippage = PlanMetricsCalculator.Compute(LongMarket, Market() with { Book = book }).MarketSlippage!;

        (slippage.SlippageTicks, slippage.Reason).Should().Be((null, UnknownReasons.LevelUnknown));
    }

    [Fact]
    public void Compute_ShouldGiveUnknownSlippage_WhenTheOppositeSideIsEmpty()
    {
        var book = Book() with { BestAsk = null };

        var slippage = PlanMetricsCalculator.Compute(LongMarket, Market() with { Book = book }).MarketSlippage!;

        slippage.Reason.Should().Be(UnknownReasons.SideEmpty);
    }

    [Fact]
    public void Compute_ShouldGiveTheFiveAndFifteenMinuteRegimes_WhenTheEngineHoldsOtherTimeframesToo()
    {
        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market());

        metrics.Regimes.Select(r => (r.TimeframeSeconds, r.Trend)).Should().Equal((300, TrendRegime.TrendingUp), (900, TrendRegime.Ranging));
    }

    [Fact]
    public void Compute_ShouldCarryTheDefinitionsVersionAndCoverage_WhenComputed()
    {
        var coverage = new PlanCoverage { ProfilePartialSinceMs = AnchorMs - (90 * Minute), VwapPartial = true, FlowPartial = true };

        var metrics = PlanMetricsCalculator.Compute(LongLimit, Market() with { Coverage = coverage });

        (metrics.DefinitionsVersion, metrics.Coverage, metrics.Instrument, metrics.AsOfMs).Should().Be((1, coverage, "MES", AsOfMs));
        metrics.Legs[0].Flow.Partial.Should().BeTrue();
    }

    private static PlanMarket Market() => new()
    {
        Root = "MES",
        ContractId = "MESZ26",
        AsOfMs = AsOfMs,
        StatusCode = "SIMULATED",
        LastTicks = 1000,
        AtrTicks = 4,
        Book = Book(),
        SliceMs = 1_000,
        RecentHeat = Slices(AsOfMs, 600, 996, bid: 12),
        Minutes = Minutes(60, _ => (1001, 997)),
        Walls = [new LiquidityWall(BookSide.Bid, 997, 50, 120_000), new LiquidityWall(BookSide.Ask, 1003, 40, 30_000)],
        Icebergs =
        [
            new IcebergReading(BookSide.Bid, 999, 30, 5, 10, 3, 10, 25, 0.8, AsOfMs - 90_000, AsOfMs - 5_000, Active: true),
            new IcebergReading(BookSide.Bid, 998, 30, 5, 10, 3, 10, 25, 0.8, AsOfMs - 90_000, AsOfMs - 5_000, Active: false),
        ],
        Signals =
        [
            Signal(1, SignalKind.Spoof, SignalBias.Bullish, AsOfMs - 60_000, 998),
            Signal(2, SignalKind.LiquiditySweep, SignalBias.Bearish, AsOfMs - 45_000, 1002),
            Signal(3, SignalKind.TrappedTraders, SignalBias.Bearish, AsOfMs - 20_000, 998),
            Signal(4, SignalKind.Spoof, SignalBias.Bullish, AsOfMs - (61 * Minute), 997),
            Signal(5, SignalKind.CvdDivergence, SignalBias.Bullish, AsOfMs - (61 * Minute), 996),
        ],
        Zones = [new ImbalanceZone(SignalBias.Bullish, 993, 995, 3, 3.5), new ImbalanceZone(SignalBias.Bearish, 1010, 1012, 3, 3.5)],
        UnfinishedAuctions = [new UnfinishedAuction(989, false, AnchorMs - (5 * Minute), 5, 5), new UnfinishedAuction(1020, true, AnchorMs, 5, 5)],
        Levels =
        [
            new PlanLevel("profile", "VAL", 990),
            new PlanLevel("profile", "POC", 1004),
            new PlanLevel("vwap", "VWAP", 1005),
            new PlanLevel("prior-session", "prior session low", 993),
        ],
        SessionDeltaByPrice = new Dictionary<long, long> { [996] = -30, [1000] = 15 },
        Regimes =
        [
            new RegimeDto(60, TrendRegime.Ranging, true, 40, 28, null, null, null, null, null, null, null),
            new RegimeDto(300, TrendRegime.TrendingUp, true, 40, 28, null, null, null, null, null, null, null),
            new RegimeDto(900, TrendRegime.Ranging, true, 40, 28, null, null, null, null, null, null, null),
        ],
        Coverage = new PlanCoverage(),
    };

    // Count closed one-second slices ending at endMs, each holding bid contracts at price for knownMs of its 1,000 ms.
    private static List<HeatmapColumn> Slices(long endMs, int count, long price, double bid, int knownMs = 1_000) =>
        [.. Enumerable.Range(0, count).Select(i =>
            new HeatmapColumn(endMs - ((count - i) * 1_000L), 1_000, [new HeatCell(price, bid * knownMs, 0, knownMs)]))];

    // Best bid 999 and best ask 1000, eleven levels each side: covered 989 to 1010.
    private static PlanBook Book()
    {
        var cells = new List<PlanBookCell>();
        for (var p = 989L; p <= 1010; p++)
        {
            long bid = p <= 999 ? (p == 997 ? 50 : 10) : 0;
            long ask = p switch
            {
                < 1000 => 0,
                1000 => 5,
                1001 => 6,
                1002 => 7,
                1003 => 40,
                _ => 8,
            };
            cells.Add(new PlanBookCell(p, bid, ask));
        }

        return new PlanBook(true, 999, 1000, 989, 1010, cells);
    }

    // Bar i of count ends at AnchorMs - (count - 1 - i) minutes: the last one closes at the anchor.
    private static List<PlanMinute> Minutes(int count, Func<int, (long High, long Low)> range) =>
        [.. Enumerable.Range(0, count).Select(i =>
        {
            var (high, low) = range(i);
            return new PlanMinute(AnchorMs - ((count - i) * Minute), high, low, Missing: false);
        })];

    private static OrderFlowSignal Signal(long id, SignalKind kind, SignalBias bias, long timeMs, long price) =>
        new(id, kind, bias, timeMs, price, price, 0.5, kind.ToString(), "synthetic");
}
