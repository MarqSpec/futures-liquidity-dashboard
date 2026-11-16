using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Book;

// reference: REQUIREMENTS.md FR-11
public sealed class OrderBookTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Apply_ShouldDropTheUpdate_WhenTheBookIsUnknown()
    {
        var book = new OrderBook();

        var change = book.Apply(BookSide.Bid, 999, 5);

        change.Should().BeNull();
        book.DroppedWhileUnknown.Should().Be(1);
        (book.IsKnown, book.BestBid, book.QuantityAt(BookSide.Bid, 999)).Should().Be((false, (long?)null, (long?)null));
    }

    [Fact]
    public void ApplySnapshot_ShouldMakeTheBookKnownWithItsBestPricesAndCoverage_WhenABaselineArrives()
    {
        var book = TestData.Book(bestAsk: 1000, levelsPerSide: 10);

        (book.IsKnown, book.BestBid, book.BestAsk).Should().Be((true, (long?)999, (long?)1000));
        (book.CoveredLow, book.CoveredHigh).Should().Be(((long?)990, (long?)1009));
    }

    [Fact]
    public void QuantityAt_ShouldBeZeroInsideCoverageAndNullOutside_WhenNoOrderRestsThere()
    {
        var book = TestData.Book(bestAsk: 1000, levelsPerSide: 10);

        book.QuantityAt(BookSide.Bid, 991).Should().Be(0);
        book.QuantityAt(BookSide.Bid, 989).Should().BeNull();
        book.QuantityAt(BookSide.Ask, 1010).Should().BeNull();
    }

    [Fact]
    public void ApplySnapshot_ShouldIgnoreEmptyLevels_WhenTheBaselineListsThem()
    {
        var book = new OrderBook();

        book.ApplySnapshot(TestData.Snapshot(T0, [new BookLevel(999, 0), new BookLevel(998, 4)], [new BookLevel(1000, 3)], 5));

        book.BestBid.Should().Be(998);
    }

    [Fact]
    public void Apply_ShouldReturnTheChange_WhenTheQuantityChanges()
    {
        var book = TestData.Book(bestAsk: 1000);

        book.Apply(BookSide.Bid, 999, 25).Should().Be(new LevelChange(BookSide.Bid, 999, 10, 25));
        book.QuantityAt(BookSide.Bid, 999).Should().Be(25);
    }

    [Fact]
    public void Apply_ShouldReturnNull_WhenTheQuantityIsUnchanged()
    {
        var book = TestData.Book(bestAsk: 1000);

        book.Apply(BookSide.Ask, 1000, 10).Should().BeNull();
    }

    [Fact]
    public void Apply_ShouldRemoveTheLevel_WhenTheQuantityIsZero()
    {
        var book = TestData.Book(bestAsk: 1000);

        var change = book.Apply(BookSide.Ask, 1000, 0);

        change!.Value.Delta.Should().Be(-10);
        book.BestAsk.Should().Be(1001);
    }

    [Fact]
    public void Apply_ShouldRemoveCrossedOpposingLevels_WhenABidIsPlacedAtOrAboveTheBestAsk()
    {
        var book = TestData.Book(bestAsk: 1000);

        book.Apply(BookSide.Bid, 1001, 5);

        (book.BestBid, book.BestAsk).Should().Be(((long?)1001, (long?)1002));
    }

    [Fact]
    public void Apply_ShouldTrimLevelsBeyondTheCoverage_WhenTheBestBidMovesUp()
    {
        var book = TestData.Book(bestAsk: 1000, levelsPerSide: 3);

        book.Apply(BookSide.Ask, 1000, 0);
        book.Apply(BookSide.Bid, 1000, 7);

        book.Bids.Select(l => l.Key).Should().Equal(1000, 999, 998);
    }

    [Fact]
    public void Apply_ShouldReturnNull_WhenThePriceIsBeyondTheCoveredDepth()
    {
        // Ten levels per side from a best bid of 999 cover bids down to 990; 985 is outside the subscribed depth.
        var book = TestData.Book(bestAsk: 1000, levelsPerSide: 10);

        var change = book.Apply(BookSide.Bid, 985, 40);

        change.Should().BeNull();
    }

    [Fact]
    public void QuantityAt_ShouldBeUnknown_WhenATrimmedTickComesBackIntoCoverage()
    {
        // Three levels per side: bids 100/99/98 cover down to 98, so a bid at 97 is outside the depth and dropped.
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10), new BookLevel(99, 10), new BookLevel(98, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Bid, 97, 50).Should().BeNull();

        // The best bid leaves, so coverage widens onto 97, whose real size the book never kept.
        book.Apply(BookSide.Bid, 100, 0);

        book.QuantityAt(BookSide.Bid, 97).Should().BeNull("a tick whose data was trimmed is unknown, never zero");
        book.Apply(BookSide.Bid, 97, 48).Should().BeNull("the change from an unknown size cannot be measured");
        book.QuantityAt(BookSide.Bid, 97).Should().Be(48);
        book.Apply(BookSide.Bid, 97, 46)!.Value.Delta.Should().Be(-2);
    }

    [Fact]
    public void QuantityAt_ShouldStayUnknown_WhenASideEmptiesAndRefills()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10), new BookLevel(99, 10), new BookLevel(98, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Bid, 97, 50);
        book.Apply(BookSide.Bid, 100, 0);

        // Every known bid is pulled, so the bid side is empty, and then a bid arrives below the old coverage.
        book.Apply(BookSide.Bid, 99, 0);
        book.Apply(BookSide.Bid, 98, 0);
        book.Bids.Should().BeEmpty();
        book.Apply(BookSide.Bid, 96, 5);

        book.QuantityAt(BookSide.Bid, 97).Should().BeNull("97 was trimmed before the side emptied");
        book.QuantityAt(BookSide.Bid, 95).Should().BeNull("95 was never covered before the side refilled");
        book.QuantityAt(BookSide.Bid, 94).Should().BeNull();
        book.QuantityAt(BookSide.Bid, 96).Should().Be(5);
        book.QuantityAt(BookSide.Bid, 99).Should().Be(0, "99 was explicitly emptied");
        book.Apply(BookSide.Bid, 97, 48).Should().BeNull("the change from an unknown size cannot be measured");
    }

    [Fact]
    public void QuantityAt_ShouldBeUnknownBetweenTheNewBestAndTheOldCoverage_WhenABidSideRefillsBelowIt()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Bid, 96, 50).Should().BeNull("96 is below the covered 98-100");
        book.Apply(BookSide.Bid, 100, 0);
        book.Bids.Should().BeEmpty();

        book.Apply(BookSide.Bid, 95, 5);

        book.QuantityAt(BookSide.Bid, 96).Should().BeNull("96 was never covered before the side emptied");
        book.QuantityAt(BookSide.Bid, 97).Should().BeNull();
        book.QuantityAt(BookSide.Bid, 94).Should().BeNull();
        book.QuantityAt(BookSide.Bid, 95).Should().Be(5);
        book.QuantityAt(BookSide.Bid, 98).Should().Be(0, "98 was inside the coverage when the side emptied");
        book.Apply(BookSide.Bid, 96, 48).Should().BeNull("the change from an unknown size cannot be measured");
    }

    [Fact]
    public void QuantityAt_ShouldBeUnknownBetweenTheNewBestAndTheOldCoverage_WhenAnAskSideRefillsAboveIt()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10), new BookLevel(99, 10), new BookLevel(98, 10)],
            [new BookLevel(101, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Ask, 105, 50).Should().BeNull("105 is above the covered 101-103");
        book.Apply(BookSide.Ask, 101, 0);
        book.Asks.Should().BeEmpty();

        book.Apply(BookSide.Ask, 106, 5);

        book.QuantityAt(BookSide.Ask, 105).Should().BeNull();
        book.QuantityAt(BookSide.Ask, 104).Should().BeNull();
        book.QuantityAt(BookSide.Ask, 107).Should().BeNull();
        book.QuantityAt(BookSide.Ask, 106).Should().Be(5);
        book.QuantityAt(BookSide.Ask, 103).Should().Be(0, "103 was inside the coverage when the side emptied");
        book.Apply(BookSide.Ask, 105, 48).Should().BeNull();
    }

    [Fact]
    public void QuantityAt_ShouldKeepTheAsksKnown_WhenTheBidsRefillAfterTheAsksFell()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Bid, 100, 0);
        book.Apply(BookSide.Ask, 90, 7);

        book.Apply(BookSide.Bid, 85, 5);

        book.QuantityAt(BookSide.Ask, 90).Should().Be(7, "the best ask is known");
        book.QuantityAt(BookSide.Ask, 91).Should().Be(0);
        book.QuantityAt(BookSide.Bid, 89).Should().BeNull("bids between the new best and the best ask were never covered");
        book.QuantityAt(BookSide.Bid, 85).Should().Be(5);
        book.Apply(BookSide.Ask, 90, 4)!.Value.Delta.Should().Be(-3);
    }

    [Fact]
    public void QuantityAt_ShouldKeepTheBestBidKnown_WhenTheAsksRefillAfterABidCrossedThemAll()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Bid, 104, 5);
        book.Asks.Should().BeEmpty();

        book.Apply(BookSide.Ask, 105, 7);

        book.QuantityAt(BookSide.Bid, 104).Should().Be(5, "the best bid is known");
        book.QuantityAt(BookSide.Ask, 106).Should().BeNull();
        book.Apply(BookSide.Bid, 104, 3)!.Value.Delta.Should().Be(-2);
    }

    [Fact]
    public void QuantityAt_ShouldBeUnknownInTheSpread_WhenTheAsksRefillWellAboveTheBestBid()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Bid, 104, 5);

        book.Apply(BookSide.Ask, 107, 7);

        book.QuantityAt(BookSide.Ask, 105).Should().BeNull("asks between the best bid and the new best ask were never covered");
        book.QuantityAt(BookSide.Ask, 106).Should().BeNull();
        book.QuantityAt(BookSide.Bid, 104).Should().Be(5);
        book.QuantityAt(BookSide.Ask, 107).Should().Be(7);
    }

    [Fact]
    public void QuantityAt_ShouldKeepTheBidSideKnownInTheSpread_WhenOnlyTheAsksAreUnknownThere()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Bid, 104, 5);

        book.Apply(BookSide.Ask, 107, 7);

        book.QuantityAt(BookSide.Ask, 105).Should().BeNull("the asks there were never covered");
        book.QuantityAt(BookSide.Bid, 105).Should().Be(0, "no bid rests above the known best bid; an ask marker says nothing about bids");
        book.QuantityAt(BookSide.Bid, 106).Should().Be(0);
    }

    [Fact]
    public void QuantityAt_ShouldKeepTheAskSideKnown_WhenOnlyTheBidsAreUnknownAtThatPrice()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Bid, 100, 0);
        book.Apply(BookSide.Ask, 90, 7);

        book.Apply(BookSide.Bid, 85, 5);

        book.QuantityAt(BookSide.Bid, 89).Should().BeNull();
        book.QuantityAt(BookSide.Ask, 89).Should().Be(0, "no ask rests below the known best ask; a bid marker says nothing about asks");
        book.QuantityAt(BookSide.Ask, 86).Should().Be(0);
    }

    [Fact]
    public void Apply_ShouldReturnTheChange_WhenOnlyTheOppositeSideIsUnknownAtThatPrice()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Bid, 104, 5);
        book.Apply(BookSide.Ask, 107, 7);

        // 106 is unknown on the ask side only; a bid there is a measurable change from a known empty bid level.
        var change = book.Apply(BookSide.Bid, 106, 4);

        change.Should().NotBeNull();
        change!.Value.Delta.Should().Be(4);
        book.QuantityAt(BookSide.Ask, 105).Should().Be(0, "a bid at 106 means nothing offers at or below it");
        book.QuantityAt(BookSide.Ask, 106).Should().Be(0);
        book.QuantityAt(BookSide.Ask, 108).Should().BeNull("the bid says nothing about asks above it");
    }

    [Fact]
    public void QuantityAt_ShouldBeUnknownBelowTheNewBest_WhenAnEmptySideRefills()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        book.Apply(BookSide.Ask, 101, 0);
        book.Apply(BookSide.Ask, 102, 0);
        book.Apply(BookSide.Ask, 103, 0);
        book.Asks.Should().BeEmpty();

        book.Apply(BookSide.Ask, 104, 7);

        book.QuantityAt(BookSide.Ask, 104).Should().Be(7);
        book.QuantityAt(BookSide.Ask, 105).Should().BeNull();
        book.QuantityAt(BookSide.Ask, 106).Should().BeNull();
        book.QuantityAt(BookSide.Ask, 103).Should().Be(0, "103 was explicitly emptied");
    }

    [Fact]
    public void Invalidate_ShouldMakeEveryLevelUnknown_WhenCalled()
    {
        var book = TestData.Book(bestAsk: 1000);

        book.Invalidate();

        book.IsKnown.Should().BeFalse();
        book.Bids.Should().BeEmpty();
        book.DepthAt(BookSide.Bid, 5).Should().BeNull();
    }

    [Fact]
    public void DepthAt_ShouldSumTheTopLevels_WhenTheBookIsKnown()
    {
        var book = TestData.Book(bestAsk: 1000);
        book.Apply(BookSide.Ask, 1001, 30);

        book.DepthAt(BookSide.Ask, 2).Should().Be(40);
    }

    [Fact]
    public void Apply_ShouldThrow_WhenTheQuantityIsNegative()
    {
        var book = TestData.Book(bestAsk: 1000);

        var act = () => book.Apply(BookSide.Bid, 999, -1);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void ApplySnapshot_ShouldThrow_WhenLevelsPerSideIsBelowOne()
    {
        var act = () => new OrderBook().ApplySnapshot(TestData.Snapshot(T0, [], [], 0));

        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}
