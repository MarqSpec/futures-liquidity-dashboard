using MarqSpec.FuturesLiquidityDashboard.Core.Bars;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Bars;

// reference: REQUIREMENTS.md FR-1, FR-13
public sealed class BarAggregatorTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Add_ShouldAccumulateOhlcvAndAggressorVolume_WhenTradesFallInOneBin()
    {
        var aggregator = new BarAggregator(1_000);

        aggregator.Add(T0, 100, 2, buyerAggressor: true);
        aggregator.Add(T0 + 200, 103, 1, buyerAggressor: false);
        aggregator.Add(T0 + 999, 99, 4, buyerAggressor: true);

        aggregator.Current.Should().BeEquivalentTo(new
        {
            StartMs = T0,
            Open = 100L,
            High = 103L,
            Low = 99L,
            Close = 99L,
            Volume = 7L,
            BuyVolume = 6L,
            SellVolume = 1L,
            TradeCount = 3,
            Delta = 5L,
        });
    }

    [Fact]
    public void AdvanceTo_ShouldCloseEveryElapsedBinIncludingEmptyOnes_WhenTimeSkipsAhead()
    {
        var aggregator = new BarAggregator(1_000);
        aggregator.Add(T0, 100, 1, true);

        var closed = aggregator.AdvanceTo(T0 + 3_500);

        closed.Select(b => (b.StartMs, b.IsEmpty)).Should().Equal((T0, false), (T0 + 1_000, true), (T0 + 2_000, true));
        aggregator.Current!.StartMs.Should().Be(T0 + 3_000);
        closed[1].Open.Should().BeNull();
    }

    [Fact]
    public void Combine_ShouldBuildOneWiderBarFromTheTradedBars_WhenGivenConsecutiveBars()
    {
        var bars = new[]
        {
            TradeBar.Empty(T0, 1_000).With(100, 2, true).With(102, 1, false),
            TradeBar.Empty(T0 + 1_000, 1_000),
            TradeBar.Empty(T0 + 2_000, 1_000).With(98, 3, false),
        };

        var combined = TradeBar.Combine(T0, 5_000, bars);

        combined.Should().BeEquivalentTo(new
        {
            StartMs = T0,
            DurationMs = 5_000,
            Open = 100L,
            High = 102L,
            Low = 98L,
            Close = 98L,
            Volume = 6L,
            BuyVolume = 2L,
            SellVolume = 4L,
            TradeCount = 3,
        });
    }

    [Fact]
    public void Combine_ShouldReturnAnEmptyBar_WhenNoBarTraded()
    {
        TradeBar.Combine(T0, 5_000, [TradeBar.Empty(T0, 1_000)]).IsEmpty.Should().BeTrue();
    }

    [Fact]
    public void Constructor_ShouldThrow_WhenTheIntervalIsNotPositive()
    {
        var act = () => new BarAggregator(0);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}
