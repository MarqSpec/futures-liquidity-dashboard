using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-49, ARCHITECTURE.md D-23
public sealed class SweepDetectorTests
{
    private static readonly long T0 = TestData.EpochMs;
    private static readonly KeyLevel High = new("prior session high", 1000, IsHigh: true);
    private static readonly KeyLevel Low = new("prior session low", 900, IsHigh: false);

    [Fact]
    public void OnTrade_ShouldReportSweep_WhenPriceBreachesAHighAndTradesBackBelowItInTime()
    {
        var detector = Watching(High, lastPrice: 998);
        detector.OnTrade(T0, 1001, 5).Should().BeEmpty();
        detector.OnTrade(T0 + 1_000, 1003, 2).Should().BeEmpty();

        var events = detector.OnTrade(T0 + 2_000, 999, 1);

        events.Should().ContainSingle().Which.Should().Be(new SweepEvent(High, ExtremeTicks: 1003, VolumeBeyond: 7, DurationMs: 2_000));
        detector.Levels.Should().BeEmpty();
    }

    [Fact]
    public void OnTrade_ShouldReportSweep_WhenPriceBreachesALowAndTradesBackAboveIt()
    {
        var detector = Watching(Low, lastPrice: 905);
        detector.OnTrade(T0, 899, 4);

        var events = detector.OnTrade(T0 + 500, 901, 1);

        events.Should().ContainSingle().Which.ExtremeTicks.Should().Be(899);
    }

    [Fact]
    public void OnTrade_ShouldNotReportSweep_WhenPriceReturnsOnlyToTheLevelItself()
    {
        var detector = Watching(High, lastPrice: 998);
        detector.OnTrade(T0, 1001, 5);

        var events = detector.OnTrade(T0 + 1_000, 1000, 1);

        events.Should().BeEmpty();
        detector.Levels.Should().ContainSingle();
    }

    [Fact]
    public void OnTrade_ShouldNotReportSweep_WhenPriceStaysBeyondTheLevel()
    {
        var detector = Watching(High, lastPrice: 998);

        var events = new[] { 1001L, 1002, 1004, 1003 }.SelectMany((p, i) => detector.OnTrade(T0 + (i * 1_000), p, 1)).ToList();

        events.Should().BeEmpty();
    }

    [Theory]
    [InlineData(120_000, 1)]
    [InlineData(120_001, 0)]
    public void OnTrade_ShouldReportSweepOnlyInsideTheReturnWindow_WhenPriceComesBack(int afterMs, int expected)
    {
        var detector = Watching(High, lastPrice: 998);
        detector.OnTrade(T0, 1001, 5);

        var events = detector.OnTrade(T0 + afterMs, 999, 1);

        events.Should().HaveCount(expected);
        detector.Levels.Should().BeEmpty();
    }

    [Fact]
    public void OnTrade_ShouldNotBreach_WhenPriceTradesFewerTicksBeyondThanRequired()
    {
        var detector = new SweepDetector(OrderFlowOptions.Default with { SweepMinTicksBeyond = 2 });
        detector.Watch(High, 998);
        detector.OnTrade(T0, 1001, 5);

        detector.OnTrade(T0 + 1_000, 999, 1).Should().BeEmpty();
    }

    [Fact]
    public void Watch_ShouldIgnoreTheLevel_WhenTheMarketAlreadyTradesBeyondIt()
    {
        var detector = Watching(High, lastPrice: 1001);

        detector.Levels.Should().BeEmpty();
    }

    [Fact]
    public void Watch_ShouldKeepOneLevel_WhenTheSamePriceAndSideIsAddedTwice()
    {
        var detector = Watching(High, lastPrice: 998);

        detector.Watch(High with { Name = "swing high" }, 998);

        detector.Levels.Should().ContainSingle().Which.Name.Should().Be("prior session high");
    }

    [Fact]
    public void Watch_ShouldDropTheOldestLevel_WhenMoreThanTwentyFourAreWatched()
    {
        var detector = new SweepDetector(OrderFlowOptions.Default);

        for (var i = 0; i < 25; i++)
        {
            detector.Watch(new KeyLevel("swing high", 2000 + i, IsHigh: true), lastPrice: null);
        }

        detector.Levels.Should().HaveCount(24);
        detector.Levels.Should().NotContain(l => l.PriceTicks == 2000);
    }

    [Fact]
    public void Describe_ShouldStateTicksVolumeAndDuration_WhenGivenASweep()
    {
        var text = SweepDetector.Describe(new SweepEvent(High, 1003, 7, 2_500));

        text.Should().Be("Ran 3 tick(s) through prior session high on 7 contracts, back inside after 2.5 s");
    }

    private static SweepDetector Watching(KeyLevel level, long? lastPrice)
    {
        var detector = new SweepDetector(OrderFlowOptions.Default);
        detector.Watch(level, lastPrice);
        return detector;
    }
}
