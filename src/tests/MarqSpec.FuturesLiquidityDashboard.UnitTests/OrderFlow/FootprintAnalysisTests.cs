using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-42, FR-43, ARCHITECTURE.md D-20
public sealed class FootprintAnalysisTests
{
    private const double Ratio = 3.0;
    private const long MinVolume = 4;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void ImbalanceFlags_ShouldFlagBuyImbalance_WhenAskAtPriceIsRatioTimesBidOneTickBelow()
    {
        var bar = TestData.Cells(T0, (100, 2, 1), (101, 1, 6));

        var flags = FootprintAnalysis.ImbalanceFlags(bar, Ratio, MinVolume);

        flags[101].Should().Be(1);
        flags[100].Should().Be(0);
    }

    [Fact]
    public void ImbalanceFlags_ShouldNotFlag_WhenAskIsJustBelowTheRatio()
    {
        var bar = TestData.Cells(T0, (100, 2, 1), (101, 1, 5));

        FootprintAnalysis.ImbalanceFlags(bar, Ratio, MinVolume)[101].Should().Be(0);
    }

    [Fact]
    public void ImbalanceFlags_ShouldFlagSellImbalance_WhenBidAtPriceIsRatioTimesAskOneTickAbove()
    {
        var bar = TestData.Cells(T0, (200, 12, 0), (201, 0, 4));

        var flags = FootprintAnalysis.ImbalanceFlags(bar, Ratio, MinVolume);

        flags[200].Should().Be(-1);
        flags[201].Should().Be(0);
    }

    [Theory]
    [InlineData(3, 0)]
    [InlineData(4, 1)]
    public void ImbalanceFlags_ShouldRequireTheMinimumVolume_WhenTheOppositeCellIsEmpty(long ask, int expected)
    {
        var bar = TestData.Cells(T0, (100, 0, 1), (101, 0, ask));

        FootprintAnalysis.ImbalanceFlags(bar, Ratio, MinVolume)[101].Should().Be(expected);
    }

    [Fact]
    public void ImbalanceFlags_ShouldReturnZero_WhenAPriceIsImbalancedBothWays()
    {
        var bar = TestData.Cells(T0, (99, 0, 0), (100, 9, 9), (101, 0, 0));

        FootprintAnalysis.ImbalanceFlags(bar, Ratio, MinVolume)[100].Should().Be(0);
    }

    [Fact]
    public void ImbalanceFlags_ShouldCoverEveryTickBetweenLowAndHigh_WhenPricesAreSkipped()
    {
        var bar = TestData.Cells(T0, (100, 1, 1), (103, 1, 1));

        FootprintAnalysis.ImbalanceFlags(bar, Ratio, MinVolume).Keys.Should().BeEquivalentTo([100L, 101L, 102L, 103L]);
    }

    [Fact]
    public void ImbalanceFlags_ShouldBeEmpty_WhenBarIsEmpty()
    {
        FootprintAnalysis.ImbalanceFlags(new FootprintBar(T0, 60_000), Ratio, MinVolume).Should().BeEmpty();
    }

    [Fact]
    public void StackedImbalances_ShouldReportAZone_WhenThreeConsecutiveTicksAreBuyImbalanced()
    {
        var bar = TestData.Cells(T0, (100, 2, 1), (101, 2, 6), (102, 2, 6), (103, 1, 6));

        var zones = FootprintAnalysis.StackedImbalances(bar, Ratio, MinVolume, minLevels: 3);

        zones.Should().ContainSingle().Which.Should().Be(new ImbalanceZone(SignalBias.Bullish, 101, 103, 3, 3.0));
    }

    [Fact]
    public void StackedImbalances_ShouldReportNothing_WhenOnlyTwoConsecutiveTicksAreImbalanced()
    {
        var bar = TestData.Cells(T0, (100, 2, 1), (101, 2, 6), (102, 2, 6), (103, 2, 1));

        FootprintAnalysis.StackedImbalances(bar, Ratio, MinVolume, minLevels: 3).Should().BeEmpty();
    }

    [Fact]
    public void StackedImbalances_ShouldReportABearishZone_WhenThreeConsecutiveTicksAreSellImbalanced()
    {
        var bar = TestData.Cells(T0, (100, 12, 0), (101, 12, 4), (102, 12, 4), (103, 0, 4));

        var zones = FootprintAnalysis.StackedImbalances(bar, Ratio, MinVolume, minLevels: 3);

        zones.Should().ContainSingle().Which.Should().Be(new ImbalanceZone(SignalBias.Bearish, 100, 102, 3, 3.0));
    }

    [Fact]
    public void UnfinishedAuctions_ShouldReportBothExtremes_WhenBothSidesTradedAtHighAndLow()
    {
        var bar = TestData.Cells(T0, (100, 2, 1), (101, 5, 5), (102, 3, 4));

        var found = FootprintAnalysis.UnfinishedAuctions(bar);

        found.Should().Equal(
            new UnfinishedAuction(102, AtHigh: true, T0, 3, 4),
            new UnfinishedAuction(100, AtHigh: false, T0, 2, 1));
    }

    [Fact]
    public void UnfinishedAuctions_ShouldReportNothing_WhenExtremesTradedOnOneSideOnly()
    {
        var bar = TestData.Cells(T0, (100, 2, 0), (101, 5, 5), (102, 0, 4));

        FootprintAnalysis.UnfinishedAuctions(bar).Should().BeEmpty();
    }

    [Fact]
    public void UnfinishedAuctions_ShouldReportOnce_WhenTheBarTradedAtASinglePrice()
    {
        var bar = TestData.Cells(T0, (100, 2, 3));

        FootprintAnalysis.UnfinishedAuctions(bar).Should().ContainSingle().Which.AtHigh.Should().BeTrue();
    }
}
