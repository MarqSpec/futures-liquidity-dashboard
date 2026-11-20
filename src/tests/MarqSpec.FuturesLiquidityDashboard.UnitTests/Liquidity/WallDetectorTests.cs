using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Liquidity;

// reference: REQUIREMENTS.md FR-12 (liquidity walls beside the heatmap)
public sealed class WallDetectorTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Detect_ShouldReportALevelAtLeastThreeTimesTheMedian_WhenOneRestsInTheBook()
    {
        var book = TestData.Book(bestAsk: 1000);
        book.Apply(BookSide.Ask, 1002, 30);
        var detector = new WallDetector();

        var walls = detector.Detect(T0, book);

        walls.Should().ContainSingle().Which.Should().Be(new LiquidityWall(BookSide.Ask, 1002, 30, AgeMs: 0));
    }

    [Fact]
    public void Detect_ShouldAgeTheWall_WhenItStaysLarge()
    {
        var book = TestData.Book(bestAsk: 1000);
        book.Apply(BookSide.Bid, 997, 50);
        var detector = new WallDetector();
        detector.Detect(T0, book);

        detector.Detect(T0 + 4_000, book).Single().AgeMs.Should().Be(4_000);
    }

    [Fact]
    public void Detect_ShouldResetTheAge_WhenTheWallDropsBelowTheThresholdAndReturns()
    {
        var book = TestData.Book(bestAsk: 1000);
        book.Apply(BookSide.Bid, 997, 50);
        var detector = new WallDetector();
        detector.Detect(T0, book);
        book.Apply(BookSide.Bid, 997, 10);
        detector.Detect(T0 + 1_000, book);
        book.Apply(BookSide.Bid, 997, 50);

        detector.Detect(T0 + 2_000, book).Single().AgeMs.Should().Be(0);
    }

    [Fact]
    public void Detect_ShouldReportNothing_WhenTheBookIsUnknown()
    {
        new WallDetector().Detect(T0, new OrderBook()).Should().BeEmpty();
    }

    [Fact]
    public void Detect_ShouldReportNothing_WhenFewerThanFourLevelsRest()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(T0, [new BookLevel(999, 100)], [new BookLevel(1000, 1), new BookLevel(1001, 1)], 10));

        new WallDetector().Detect(T0, book).Should().BeEmpty();
    }
}

// reference: REQUIREMENTS.md FR-78 (what happened to a wall: filled, pulled or below the threshold)
public sealed class WallDetectorOutcomeTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Ended_ShouldRecordAPulledWallAndHowLongItStood_WhenMostOfItsSizeWasPulled()
    {
        var (book, detector) = WallAt(BookSide.Ask, 1002, 50);

        Decrease(detector, book, BookSide.Ask, 1002, to: 0, filled: 5);
        detector.Detect(T0 + 5_000, book);

        detector.Ended(T0 + 5_000).Should().ContainSingle().Which.Should().Be(
            new EndedWall(BookSide.Ask, 1002, PeakQuantity: 50, Filled: 5, Pulled: 45, StoodMs: 5_000, EndedMs: T0 + 5_000, WallOutcome.Pulled));
    }

    [Fact]
    public void Ended_ShouldRecordAFilledWall_WhenMostOfItsSizeTraded()
    {
        var (book, detector) = WallAt(BookSide.Bid, 997, 50);

        Decrease(detector, book, BookSide.Bid, 997, to: 0, filled: 40);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Single().Outcome.Should().Be(WallOutcome.Filled);
    }

    [Fact]
    public void Ended_ShouldRecordBelowThreshold_WhenAtLeastHalfItsPeakStillRests()
    {
        var (book, detector) = WallAt(BookSide.Bid, 997, 50);

        Decrease(detector, book, BookSide.Bid, 997, to: 25, filled: 0);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Single().Should().Match<EndedWall>(w => w.Outcome == WallOutcome.BelowThreshold && w.Pulled == 25);
    }

    [Fact]
    public void Ended_ShouldJudgeByThePeakItGrewTo_WhenTheWallGrewBeforeItWent()
    {
        var (book, detector) = WallAt(BookSide.Bid, 997, 50);
        var grow = book.Apply(BookSide.Bid, 997, 80)!.Value;
        detector.OnLevelChange(grow, default);

        Decrease(detector, book, BookSide.Bid, 997, to: 29, filled: 0);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Single().Should().Match<EndedWall>(w => w.PeakQuantity == 80 && w.Outcome == WallOutcome.Pulled);
    }

    [Fact]
    public void Ended_ShouldRecordNothing_WhenTheWallWasNeverAmongTheReportedThree()
    {
        var book = TestData.Book(bestAsk: 1000);
        book.Apply(BookSide.Bid, 999, 60);
        book.Apply(BookSide.Bid, 998, 50);
        book.Apply(BookSide.Bid, 997, 40);
        book.Apply(BookSide.Bid, 996, 35);
        var detector = new WallDetector();
        detector.Detect(T0, book);

        Decrease(detector, book, BookSide.Bid, 996, to: 0, filled: 0);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Should().BeEmpty();
    }

    [Fact]
    public void Ended_ShouldKeepOnlyTheFiveMostRecentNewestFirst_WhenSixWallsEnd()
    {
        var book = TestData.Book(bestAsk: 1000);
        var detector = new WallDetector();
        (BookSide Side, long Price)[] walls = [(BookSide.Bid, 999), (BookSide.Bid, 998), (BookSide.Bid, 997), (BookSide.Ask, 1001), (BookSide.Ask, 1002), (BookSide.Ask, 1003)];
        for (var i = 0; i < walls.Length; i++)
        {
            var (side, price) = walls[i];
            book.Apply(side, price, 50);
            detector.Detect(T0 + (i * 1_000L), book);
            Decrease(detector, book, side, price, to: 1, filled: 0);
            detector.Detect(T0 + (i * 1_000L) + 500, book);
        }

        detector.Ended(T0 + 6_000).Select(w => w.PriceTicks).Should().Equal(1003, 1002, 1001, 997, 998);
    }

    [Fact]
    public void Ended_ShouldShowAWallUntilFifteenMinutesAfterItEnded_WhenTheClockAdvances()
    {
        var (book, detector) = WallAt(BookSide.Ask, 1002, 50);
        Decrease(detector, book, BookSide.Ask, 1002, to: 0, filled: 0);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000 + WallDetector.EndedShownMs - 1).Should().HaveCount(1);
        detector.Ended(T0 + 1_000 + WallDetector.EndedShownMs).Should().BeEmpty();
    }

    [Fact]
    public void Ended_ShouldRecordNothing_WhenTheWallLeavesTheCoveredDepth()
    {
        var (book, detector) = WallAt(BookSide.Bid, 990, 50);

        // A bid at the old best ask moves coverage up a tick and trims the deepest bid, the wall, unseen.
        book.Apply(BookSide.Bid, 1000, 10);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Should().BeEmpty();
    }

    [Fact]
    public void Ended_ShouldRecordNothing_WhenTheBookWasResetWhileTheWallStood()
    {
        var (book, detector) = WallAt(BookSide.Ask, 1002, 50);

        detector.Reset();
        Decrease(detector, book, BookSide.Ask, 1002, to: 0, filled: 0);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Should().BeEmpty();
    }

    [Fact]
    public void Ended_ShouldKeepWallsThatAlreadyEnded_WhenTheBookBecomesUnknown()
    {
        var (book, detector) = WallAt(BookSide.Ask, 1002, 50);
        Decrease(detector, book, BookSide.Ask, 1002, to: 0, filled: 0);
        detector.Detect(T0 + 1_000, book);

        book.Invalidate();
        detector.Detect(T0 + 2_000, book);

        detector.Ended(T0 + 2_000).Should().ContainSingle();
    }

    // Review 5983481702: every quantity the wall went through must have been seen, or its split may miss what left.
    [Fact]
    public void Ended_ShouldRecordNothing_WhenTheLevelWentWithNoChangeSeen()
    {
        var (book, detector) = WallAt(BookSide.Ask, 1002, 50);

        // Removed with no change, as a crossing level removes it.
        book.Apply(BookSide.Ask, 1002, 0);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Should().BeEmpty();
    }

    [Fact]
    public void Ended_ShouldRecordNothing_WhenAChangeStartsFromASizeTheDetectorDidNotKnow()
    {
        var (book, detector) = WallAt(BookSide.Ask, 1002, 50);
        book.Apply(BookSide.Ask, 1002, 40);

        Decrease(detector, book, BookSide.Ask, 1002, to: 0, filled: 0);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Should().BeEmpty();
    }

    [Fact]
    public void Ended_ShouldRecordNothing_WhenADetectSawASizeNoChangeReported()
    {
        var (book, detector) = WallAt(BookSide.Ask, 1002, 50);
        book.Apply(BookSide.Ask, 1002, 60);
        detector.Detect(T0 + 500, book);

        Decrease(detector, book, BookSide.Ask, 1002, to: 0, filled: 0);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Should().BeEmpty();
    }

    [Fact]
    public void Ended_ShouldRecordTheWall_WhenItChurnedAndEveryChangeWasSeen()
    {
        var (book, detector) = WallAt(BookSide.Ask, 1002, 50);
        Decrease(detector, book, BookSide.Ask, 1002, to: 35, filled: 0);
        detector.OnLevelChange(book.Apply(BookSide.Ask, 1002, 50)!.Value, default);
        detector.Detect(T0 + 500, book);

        Decrease(detector, book, BookSide.Ask, 1002, to: 0, filled: 40);
        detector.Detect(T0 + 1_000, book);

        detector.Ended(T0 + 1_000).Should().ContainSingle().Which.Should().Match<EndedWall>(w =>
            w.Filled == 40 && w.Pulled == 25 && w.Outcome == WallOutcome.Filled);
    }

    // (ruling C)
    [Fact]
    public void Ended_ShouldKeepOneEntryWithTheLatestEndAndOutcome_WhenTheSameWallEndsTwice()
    {
        var (book, detector) = WallAt(BookSide.Bid, 997, 50);
        Decrease(detector, book, BookSide.Bid, 997, to: 25, filled: 0);
        detector.Detect(T0 + 1_000, book);
        book.Apply(BookSide.Bid, 997, 50);
        detector.Detect(T0 + 2_000, book);

        Decrease(detector, book, BookSide.Bid, 997, to: 0, filled: 40);
        detector.Detect(T0 + 3_000, book);

        detector.Ended(T0 + 3_000).Should().ContainSingle().Which.Should().Match<EndedWall>(w =>
            w.EndedMs == T0 + 3_000 && w.Outcome == WallOutcome.Filled && w.StoodMs == 1_000);
    }

    [Fact]
    public void Ended_ShouldKeepBothEntries_WhenWallsOnEachSideEndAtTheSamePrice()
    {
        var (book, detector) = WallAt(BookSide.Ask, 1002, 50);
        Decrease(detector, book, BookSide.Ask, 1002, to: 0, filled: 0);
        detector.Detect(T0 + 1_000, book);

        // The market moves up through 1002; a bid wall then stands and ends at the same price.
        book.ApplySnapshot(TestData.Snapshot(T0 + 2_000, bestAsk: 1005));
        detector.Reset();
        book.Apply(BookSide.Bid, 1002, 50);
        detector.Detect(T0 + 2_000, book);
        Decrease(detector, book, BookSide.Bid, 1002, to: 0, filled: 0);
        detector.Detect(T0 + 3_000, book);

        detector.Ended(T0 + 3_000).Select(w => (w.Side, w.PriceTicks)).Should().Equal((BookSide.Bid, 1002L), (BookSide.Ask, 1002L));
    }

    private static (OrderBook Book, WallDetector Detector) WallAt(BookSide side, long price, long quantity)
    {
        var book = TestData.Book(bestAsk: 1000);
        book.Apply(side, price, quantity);
        var detector = new WallDetector();
        detector.Detect(T0, book);
        return (book, detector);
    }

    /// <summary>Takes a level down to <paramref name="to"/>, the way FR-38 would split it with <paramref name="filled"/> traded.</summary>
    private static void Decrease(WallDetector detector, OrderBook book, BookSide side, long price, long to, long filled)
    {
        var change = book.Apply(side, price, to)!.Value;
        var removed = -change.Delta;
        detector.OnLevelChange(change, new FlowSplit(filled, removed - filled));
    }
}
