using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Engine;

// reference: REQUIREMENTS.md FR-36, FR-37, FR-39 (top of book, depth imbalance, delta, trade rate and session volume)
public sealed class InstrumentEngineLiquidityTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Snapshot_ShouldGiveSpreadOneAndMicropriceOneHundredPointSevenFive_WhenBidIsHundredByThirtyAndAskIsHundredAndOneByTen()
    {
        var engine = EngineWithBook(bids: [new(100, 30)], asks: [new(101, 10)]);

        var liquidity = engine.Snapshot(60, null).Liquidity;

        liquidity.SpreadTicks.Should().Be(1);
        liquidity.Microprice.Should().Be(100.75);
        (liquidity.BestBid, liquidity.BestBidQuantity, liquidity.BestAsk, liquidity.BestAskQuantity).Should().Be((100L, 30L, 101L, 10L));
    }

    [Fact]
    public void Snapshot_ShouldGiveNullsAndNoDepthReading_WhenTheBookIsUnknown()
    {
        var engine = NewEngine();

        var liquidity = engine.Snapshot(60, null).Liquidity;

        (liquidity.BestBid, liquidity.BestAsk, liquidity.SpreadTicks, liquidity.Microprice).Should().Be((null, null, null, null));
        liquidity.Depth.Should().BeEmpty();
    }

    [Fact]
    public void Snapshot_ShouldGiveNoSpreadOrMicroprice_WhenOneSideOfTheBookIsEmpty()
    {
        var engine = EngineWithBook(bids: [new(100, 30)], asks: []);

        var liquidity = engine.Snapshot(60, null).Liquidity;

        (liquidity.SpreadTicks, liquidity.Microprice).Should().Be((null, null));
    }

    [Fact]
    public void Snapshot_ShouldGiveImbalanceOneThirdAtOneLevelAndThreeFifthsAtFiveLevels_WhenBidsAreTenTwentyThirtyAgainstAsksOfFive()
    {
        var engine = EngineWithBook(
            bids: [new(99, 10), new(98, 20), new(97, 30)],
            asks: [new(100, 5), new(101, 5), new(102, 5)]);

        var depth = engine.Snapshot(60, null).Liquidity.Depth;

        depth.Select(d => d.Levels).Should().Equal(1, 5, 10);
        depth[0].Imbalance.Should().BeApproximately(0.333, 0.0005);
        depth[1].Imbalance.Should().BeApproximately(0.6, 0.0005);
        (depth[1].Bid, depth[1].Ask).Should().Be((60L, 15L));
    }

    [Fact]
    public void Snapshot_ShouldSumSignedQuantityIntoCumulativeAndSixtySecondDeltaAndCountSessionVolume_WhenKnownPrintsArrive()
    {
        var engine = LiveEngine();

        engine.Apply(TestData.Trade(T0 + 1_000, TestData.EsBase, 5, BookSide.Bid, "p1"));
        engine.Apply(TestData.Trade(T0 + 2_000, TestData.EsBase, 2, BookSide.Ask, "p2"));
        engine.Apply(TestData.Trade(T0 + 3_000, TestData.EsBase, 4, BookSide.Bid, "p3"));

        var liquidity = engine.Snapshot(60, null).Liquidity;
        liquidity.CumulativeDelta.Should().Be(7);
        liquidity.Delta60s.Should().Be(7);
        liquidity.SessionVolume.Should().Be(11);
    }

    [Fact]
    public void Snapshot_ShouldCountTheLastTenSecondsOverTenAsTradeRateAndDropPrintsOlderThanSixtySecondsFromTheDelta_WhenTheClockAdvances()
    {
        var engine = LiveEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, TestData.EsBase, 30, BookSide.Bid, "r1"));
        engine.Apply(TestData.Trade(T0 + 9_000, TestData.EsBase, 20, BookSide.Ask, "r2"));

        engine.Tick(T0 + 10_500);
        var atTenAndAHalf = engine.Snapshot(60, null).Liquidity;
        engine.Tick(T0 + 12_000);
        var atTwelve = engine.Snapshot(60, null).Liquidity;
        engine.Tick(T0 + 61_000);
        var atSixtyOne = engine.Snapshot(60, null).Liquidity;
        engine.Tick(T0 + 70_000);
        var atSeventy = engine.Snapshot(60, null).Liquidity;

        atTenAndAHalf.TradeRate.Should().Be(5.0);
        atTwelve.TradeRate.Should().Be(2.0);
        (atTwelve.Delta60s, atSixtyOne.Delta60s, atSeventy.Delta60s).Should().Be((10L, -20L, 0L));
        atSeventy.TradeRate.Should().Be(0);
        atSeventy.CumulativeDelta.Should().Be(10, "the 60 s delta is a window, the cumulative delta is not");
    }

    [Fact]
    public void Apply_ShouldResetCumulativeDeltaAndSessionVolumeToZero_WhenATradeOpensTheNextSession()
    {
        var engine = LiveEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, TestData.EsBase, 5, BookSide.Bid, "s1"));
        engine.Apply(TestData.Trade(T0 + 2_000, TestData.EsBase, 9, BookSide.Ask, "s2"));
        engine.Snapshot(60, null).Liquidity.CumulativeDelta.Should().Be(-4);

        var nextSessionMs = T0 + (9 * 60 * 60_000L) + 5 * 60_000;
        engine.Apply(TestData.Trade(nextSessionMs, TestData.EsBase, 3, BookSide.Bid, "s3"));

        var liquidity = engine.Snapshot(60, null).Liquidity;
        liquidity.CumulativeDelta.Should().Be(3, "only the new session's print is counted");
        liquidity.SessionVolume.Should().Be(3);
    }

    [Fact]
    public void Snapshot_ShouldListAnEndedWallWithFlowSplitByPrints_WhenAReportedWallIsTakenDown()
    {
        var engine = LiveEngine();
        var wall = TestData.EsBase + 2;
        engine.Apply(TestData.Depth(T0 + 100, BookSide.Ask, wall, 50));
        engine.Snapshot(60, null).Liquidity.Walls.Should().ContainSingle(w => w.PriceTicks == wall);

        engine.Apply(TestData.Trade(T0 + 1_000, wall, 20, BookSide.Bid, "w1"));
        engine.Apply(TestData.Depth(T0 + 1_100, BookSide.Ask, wall, 0));

        engine.Snapshot(60, null).Liquidity.EndedWalls.Should().ContainSingle().Which.Should().Match<EndedWall>(w =>
            w.PriceTicks == wall && w.Filled == 20 && w.Pulled == 30 && w.StoodMs == 1_000 && w.Outcome == WallOutcome.Pulled);
    }

    [Fact]
    public void Snapshot_ShouldListNoEndedWall_WhenANewDepthSnapshotReplacesTheBookTheWallStoodIn()
    {
        var engine = LiveEngine();
        engine.Apply(TestData.Depth(T0 + 100, BookSide.Ask, TestData.EsBase + 2, 50));
        engine.Snapshot(60, null);

        engine.Apply(TestData.Snapshot(T0 + 1_000));

        engine.Snapshot(60, null).Liquidity.EndedWalls.Should().BeEmpty();
    }

    // Regression, review 5982800707: a crossing bid removes the ask levels without a change, so FR-38 never saw 40 of the 50 go.
    [Fact]
    public void Snapshot_ShouldListNoEndedWall_WhenACrossingLevelRemovedTheWallUnseen()
    {
        var engine = LiveEngine();
        var wall = TestData.EsBase + 2;
        engine.Apply(TestData.Depth(T0 + 100, BookSide.Ask, wall, 50));
        engine.Snapshot(60, null);
        engine.Apply(TestData.Depth(T0 + 200, BookSide.Ask, wall, 40));
        engine.Apply(TestData.Trade(T0 + 300, TestData.EsBase, 10, BookSide.Bid, "x1"));
        engine.Apply(TestData.Trade(T0 + 300, TestData.EsBase + 1, 10, BookSide.Bid, "x2"));
        engine.Apply(TestData.Trade(T0 + 300, wall, 40, BookSide.Bid, "x3"));

        engine.Apply(TestData.Depth(T0 + 400, BookSide.Bid, wall, 5));
        engine.Apply(TestData.Depth(T0 + 500, BookSide.Ask, wall, 0));

        engine.Snapshot(60, null).Liquidity.EndedWalls.Should().BeEmpty();
    }

    // Regression, review 5983481702: churn had covered the peak, so a tally check passed though the last 60 left unseen.
    [Fact]
    public void Snapshot_ShouldListNoEndedWall_WhenAChurnedWallIsRemovedUnseenByACrossingLevel()
    {
        var engine = LiveEngine();
        var wall = TestData.EsBase + 2;
        var t = T0 + 100;
        engine.Apply(TestData.Depth(t, BookSide.Ask, wall, 100));
        engine.Snapshot(60, null);
        for (var i = 0; i < 2; i++)
        {
            engine.Apply(TestData.Depth(t += 100, BookSide.Ask, wall, 70));
            engine.Snapshot(60, null);
            engine.Apply(TestData.Depth(t += 100, BookSide.Ask, wall, 100));
            engine.Snapshot(60, null);
        }

        engine.Apply(TestData.Trade(t += 100, wall, 40, BookSide.Bid, "c1"));
        engine.Apply(TestData.Depth(t += 100, BookSide.Ask, wall, 60));
        engine.Snapshot(60, null);
        engine.Apply(TestData.Trade(t += 100, TestData.EsBase, 10, BookSide.Bid, "c2"));
        engine.Apply(TestData.Trade(t, TestData.EsBase + 1, 10, BookSide.Bid, "c3"));
        engine.Apply(TestData.Trade(t, wall, 60, BookSide.Bid, "c4"));
        engine.Apply(TestData.Depth(t += 100, BookSide.Bid, wall, 5));
        engine.Apply(TestData.Depth(t += 100, BookSide.Ask, wall, 0));

        engine.Snapshot(60, null).Liquidity.EndedWalls.Should().BeEmpty();
    }

    private static InstrumentEngine NewEngine() => new(InstrumentCatalog.MES, null, TestData.Calendar());

    private static InstrumentEngine LiveEngine()
    {
        var engine = NewEngine();
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));
        return engine;
    }

    private static InstrumentEngine EngineWithBook(IReadOnlyList<BookLevel> bids, IReadOnlyList<BookLevel> asks)
    {
        var engine = NewEngine();
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0, bids, asks, levelsPerSide: 10));
        return engine;
    }
}
