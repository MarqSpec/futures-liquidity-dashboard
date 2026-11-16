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
