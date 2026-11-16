using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-48, ARCHITECTURE.md D-22
public sealed class SpoofDetectorTests
{
    private const long LargeBid = 994;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void OnLevelChange_ShouldReportSpoof_WhenALargeBidIsPulledAsTheMarketApproaches()
    {
        var (detector, book) = PlaceLargeBid();
        Approach(detector, book, T0 + 1_000);

        var spoof = Pull(detector, book, T0 + 3_000);

        spoof.Should().Be(new SpoofEvent(BookSide.Bid, LargeBid, PeakQuantity: 50, Pulled: 45, Filled: 0, RestedMs: 3_000, DistanceTicks: 2, FurthestTicks: 5));
    }

    [Theory]
    [InlineData(1_999, false)]
    [InlineData(2_000, true)]
    public void OnLevelChange_ShouldRequireTheMinimumRest_WhenALargeBidIsPulled(int restedMs, bool reported)
    {
        var (detector, book) = PlaceLargeBid();
        Approach(detector, book, T0 + 500);

        var spoof = Pull(detector, book, T0 + restedMs);

        (spoof is not null).Should().Be(reported);
    }

    [Fact]
    public void OnLevelChange_ShouldNotReportSpoof_WhenTheLargeBidWasMostlyFilled()
    {
        var (detector, book) = PlaceLargeBid();
        Approach(detector, book, T0 + 1_000);
        detector.OnTrade(T0 + 2_900, LargeBid, 40, BookSide.Bid);

        var spoof = Pull(detector, book, T0 + 3_000);

        spoof.Should().BeNull();
    }

    [Fact]
    public void OnLevelChange_ShouldNotReportSpoof_WhenTheMarketNeverCameWithinTheProximity()
    {
        var (detector, book) = PlaceLargeBid();

        var spoof = Pull(detector, book, T0 + 3_000);

        spoof.Should().BeNull();
    }

    [Fact]
    public void OnLevelChange_ShouldNotReportSpoof_WhenTheOrderWasPlacedNearAndTheMarketNeverMovedAway()
    {
        // Placed two ticks under the best bid: the market was never further away, so there was no approach.
        var book = TestData.Book(bestAsk: 1000);
        var detector = new SpoofDetector(OrderFlowOptions.Default);
        detector.OnLevelChange(T0, book.Apply(BookSide.Bid, 997, 50)!.Value, book);

        var spoof = detector.OnLevelChange(T0 + 3_000, book.Apply(BookSide.Bid, 997, 5)!.Value, book);

        spoof.Should().BeNull();
    }

    [Fact]
    public void OnLevelChange_ShouldNotReportSpoof_WhenTheOrderWasNeverLargeEnough()
    {
        // The median level is 10, so the large threshold is 30; 25 never becomes a candidate.
        var book = TestData.Book(bestAsk: 1000);
        var detector = new SpoofDetector(OrderFlowOptions.Default);
        detector.OnLevelChange(T0, book.Apply(BookSide.Bid, LargeBid, 25)!.Value, book);
        Approach(detector, book, T0 + 1_000);

        var spoof = detector.OnLevelChange(T0 + 3_000, book.Apply(BookSide.Bid, LargeBid, 1)!.Value, book);

        spoof.Should().BeNull();
    }

    [Fact]
    public void Reset_ShouldForgetCandidates_WhenTheBookIsNoLongerKnown()
    {
        var (detector, book) = PlaceLargeBid();
        Approach(detector, book, T0 + 1_000);

        detector.Reset();

        Pull(detector, book, T0 + 3_000).Should().BeNull();
    }

    /// <summary>Bids 995–999 and asks 1000–1004 of 10, then 50 bid at 994: five ticks under the best bid.</summary>
    private static (SpoofDetector Detector, OrderBook Book) PlaceLargeBid()
    {
        var book = TestData.Book(bestAsk: 1000);
        var detector = new SpoofDetector(OrderFlowOptions.Default);
        detector.OnLevelChange(T0, book.Apply(BookSide.Bid, LargeBid, 50)!.Value, book).Should().BeNull();
        return (detector, book);
    }

    /// <summary>The bids at 999, 998 and 997 trade away: the best bid falls to 996, two ticks above the large bid.</summary>
    private static void Approach(SpoofDetector detector, OrderBook book, long timeMs)
    {
        foreach (var price in new long[] { 999, 998, 997 })
        {
            var change = book.Apply(BookSide.Bid, price, 0)!.Value;
            detector.OnBookMoved(book);
            detector.OnLevelChange(timeMs, change, book).Should().BeNull();
        }
    }

    private static SpoofEvent? Pull(SpoofDetector detector, OrderBook book, long timeMs) =>
        detector.OnLevelChange(timeMs, book.Apply(BookSide.Bid, LargeBid, 5)!.Value, book);
}
