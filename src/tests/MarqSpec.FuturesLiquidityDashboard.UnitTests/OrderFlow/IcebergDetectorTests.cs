using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-52, ARCHITECTURE.md D-19
public sealed class IcebergDetectorTests
{
    private const long Price = 24_000;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void OnLevelChange_ShouldReportIceberg_WhenLevelRefillsTwiceAfterTradingBeyondItsPeak()
    {
        var detector = new IcebergDetector(OrderFlowOptions.Default);

        var first = PrintAndRefill(detector, T0, quantity: 8);
        var second = PrintAndRefill(detector, T0 + 400, quantity: 8);

        first.Should().BeNull();
        second.Should().BeEquivalentTo(new IcebergReading(
            BookSide.Ask, Price, Traded: 16, Displayed: 10, PeakDisplayed: 10, Refills: 2, AverageRefill: 8,
            HiddenEstimate: 6, Confidence: 0.404, FirstSeenMs: T0, LastFillMs: T0 + 400, Active: true));
    }

    [Fact]
    public void OnLevelChange_ShouldReportOnlyOnce_WhenLevelKeepsRefillingAfterDetection()
    {
        var detector = new IcebergDetector(OrderFlowOptions.Default);
        PrintAndRefill(detector, T0, 8);
        PrintAndRefill(detector, T0 + 400, 8);

        var third = PrintAndRefill(detector, T0 + 800, 8);

        third.Should().BeNull();
        detector.Readings().Should().ContainSingle().Which.Traded.Should().Be(24);
    }

    [Fact]
    public void OnLevelChange_ShouldNotReport_WhenTradedIsBelowTheMinimumMultipleOfPeak()
    {
        // Confidence gate off so only the traded-to-peak multiple decides: 12 traded against a peak of 10 is < 1.25×.
        var detector = new IcebergDetector(OrderFlowOptions.Default with { IcebergMinConfidence = 0 });

        PrintAndRefill(detector, T0, 6);
        var reading = PrintAndRefill(detector, T0 + 400, 6);

        reading.Should().BeNull();
        detector.Readings().Should().BeEmpty();
    }

    [Fact]
    public void OnTrade_ShouldReport_WhenTradedReachesExactlyTheMinimumMultipleOfPeak()
    {
        // Peak 8 → 1.25 × 8 = 10 contracts; two refills and 9 traded fall one short, the next print reaches it.
        var detector = new IcebergDetector(OrderFlowOptions.Default with { IcebergMinConfidence = 0 });
        PrintAndRefill(detector, T0, 5, displayed: 8);
        PrintAndRefill(detector, T0 + 400, 4, displayed: 8).Should().BeNull();

        var reading = detector.OnTrade(T0 + 800, Price, 1, BookSide.Ask, displayed: 8);

        reading.Should().NotBeNull();
        reading!.Traded.Should().Be(10);
    }

    [Theory]
    [InlineData(1_500, true)]
    [InlineData(1_501, false)]
    public void OnLevelChange_ShouldCountRefillOnlyInsideTheRefillWindow_WhenSizeReturnsAfterAPrint(int delayMs, bool detected)
    {
        var detector = new IcebergDetector(OrderFlowOptions.Default);

        PrintAndRefill(detector, T0, 8, refillDelayMs: delayMs);
        var reading = PrintAndRefill(detector, T0 + 2_000, 8, refillDelayMs: delayMs);

        (reading is not null).Should().Be(detected);
    }

    [Fact]
    public void OnLevelChange_ShouldKeepDetectionListedAsClosed_WhenLevelIsRemoved()
    {
        var detector = new IcebergDetector(OrderFlowOptions.Default);
        PrintAndRefill(detector, T0, 8);
        PrintAndRefill(detector, T0 + 400, 8);

        detector.OnLevelChange(T0 + 900, new LevelChange(BookSide.Ask, Price, 10, 0)).Should().BeNull();

        detector.Readings().Should().ContainSingle().Which.Active.Should().BeFalse();
    }

    [Theory]
    [InlineData(10, 10, 0, 0.0)]
    [InlineData(5, 10, 6, 0.0)]
    [InlineData(12, 10, 3, 0.309)]
    [InlineData(16, 10, 2, 0.404)]
    [InlineData(20, 10, 6, 0.779)]
    [InlineData(20, 10, 12, 0.779)]
    [InlineData(3, 0, 0, 0.519)]
    public void Confidence_ShouldFollowTheDocumentedFormula_WhenGivenTradedPeakAndRefills(long traded, long peak, int refills, double expected)
    {
        IcebergDetector.Confidence(traded, peak, refills).Should().Be(expected);
    }

    [Fact]
    public void Expire_ShouldKeepEpisodeOpen_WhenIdleForExactlyTheIdleWindow()
    {
        var detector = Detected();

        detector.Expire(T0 + 400 + 60_000);

        detector.Readings().Should().ContainSingle().Which.Active.Should().BeTrue();
    }

    [Fact]
    public void Expire_ShouldCloseEpisode_WhenIdleLongerThanTheIdleWindow()
    {
        var detector = Detected();

        detector.Expire(T0 + 400 + 60_001);

        detector.Readings().Should().ContainSingle().Which.Active.Should().BeFalse();
    }

    [Fact]
    public void Expire_ShouldForgetClosedDetection_WhenOlderThanTheRetention()
    {
        var detector = Detected();
        var closedAt = T0 + 400 + 60_001;
        detector.Expire(closedAt);

        detector.Expire(closedAt + 180_000);
        var retained = detector.Readings().Count;
        detector.Expire(closedAt + 180_001);

        retained.Should().Be(1);
        detector.Readings().Should().BeEmpty();
    }

    [Fact]
    public void Reset_ShouldForgetEveryEpisode_WhenTheBookIsNoLongerKnown()
    {
        var detector = Detected();

        detector.Reset();

        detector.Readings().Should().BeEmpty();
        detector.OnLevelChange(T0 + 1_000, new LevelChange(BookSide.Ask, Price, 2, 10)).Should().BeNull();
    }

    private static IcebergDetector Detected()
    {
        var detector = new IcebergDetector(OrderFlowOptions.Default);
        PrintAndRefill(detector, T0, 8);
        PrintAndRefill(detector, T0 + 400, 8);
        return detector;
    }

    /// <summary>A print against the ask, the level dropping by the print, then refilling to its displayed size.</summary>
    private static IcebergReading? PrintAndRefill(IcebergDetector detector, long timeMs, long quantity, long displayed = 10, int refillDelayMs = 200)
    {
        var onTrade = detector.OnTrade(timeMs, Price, quantity, BookSide.Ask, displayed);
        var onDrop = detector.OnLevelChange(timeMs + 50, new LevelChange(BookSide.Ask, Price, displayed, displayed - quantity));
        var onRefill = detector.OnLevelChange(timeMs + refillDelayMs, new LevelChange(BookSide.Ask, Price, displayed - quantity, displayed));
        return onTrade ?? onDrop ?? onRefill;
    }
}
