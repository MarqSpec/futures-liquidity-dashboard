using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-41 (footprint bars on half-open bins)
public sealed class FootprintAggregatorTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Add_ShouldStartTheBarAtTheFlooredInterval_WhenFirstTradeIsMidInterval()
    {
        var aggregator = new FootprintAggregator(60_000);

        var closed = aggregator.Add(T0 + 12_345, 100, 1, true);

        closed.Should().BeEmpty();
        aggregator.Current!.StartMs.Should().Be(T0);
    }

    [Fact]
    public void Add_ShouldKeepTradesInOneBar_WhenTheyFallInsideTheInterval()
    {
        var aggregator = new FootprintAggregator(60_000);

        aggregator.Add(T0, 100, 1, true);
        var closed = aggregator.Add(T0 + 59_999, 101, 2, false);

        closed.Should().BeEmpty();
        aggregator.Current!.Volume.Should().Be(3);
    }

    [Fact]
    public void Add_ShouldCloseTheBar_WhenATradeLandsExactlyOnTheIntervalEnd()
    {
        var aggregator = new FootprintAggregator(60_000);
        aggregator.Add(T0, 100, 1, true);

        var closed = aggregator.Add(T0 + 60_000, 101, 2, false);

        closed.Should().ContainSingle().Which.Volume.Should().Be(1);
        aggregator.Current!.StartMs.Should().Be(T0 + 60_000);
        aggregator.Current.Volume.Should().Be(2);
    }

    [Fact]
    public void Add_ShouldCloseEmptyBins_WhenTradesSkipIntervals()
    {
        var aggregator = new FootprintAggregator(60_000);
        aggregator.Add(T0, 100, 1, true);

        var closed = aggregator.Add(T0 + 180_000, 101, 1, true);

        closed.Select(b => b.StartMs).Should().Equal(T0, T0 + 60_000, T0 + 120_000);
        closed.Select(b => b.IsEmpty).Should().Equal(false, true, true);
    }

    [Fact]
    public void AdvanceTo_ShouldReturnNothing_WhenNoBarHasStarted()
    {
        var aggregator = new FootprintAggregator(60_000);

        aggregator.AdvanceTo(T0 + 600_000).Should().BeEmpty();
        aggregator.Current.Should().BeNull();
    }

    [Fact]
    public void AdvanceTo_ShouldCloseTheFormingBar_WhenTimePassesItsEnd()
    {
        var aggregator = new FootprintAggregator(60_000);
        aggregator.Add(T0, 100, 1, true);

        var closed = aggregator.AdvanceTo(T0 + 60_000);

        closed.Should().ContainSingle();
        aggregator.Current!.IsEmpty.Should().BeTrue();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Constructor_ShouldThrow_WhenIntervalIsNotPositive(int interval)
    {
        var act = () => new FootprintAggregator(interval);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}
