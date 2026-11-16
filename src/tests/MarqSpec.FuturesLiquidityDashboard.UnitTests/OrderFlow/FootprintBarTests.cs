using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-41
public sealed class FootprintBarTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Add_ShouldSplitVolumeByAggressorAtEachPrice_WhenTradesArrive()
    {
        var bar = new FootprintBar(T0, 60_000);

        bar.Add(100, 3, buyerAggressor: true);
        bar.Add(100, 2, buyerAggressor: false);
        bar.Add(101, 4, buyerAggressor: true);

        bar.Cells.Should().Equal(new FootprintCell(100, 2, 3), new FootprintCell(101, 0, 4));
        bar.AskVolume.Should().Be(7);
        bar.BidVolume.Should().Be(2);
        bar.Volume.Should().Be(9);
        bar.Delta.Should().Be(5);
    }

    [Fact]
    public void Add_ShouldTrackTheRunningDeltaExtremes_WhenDeltaSwingsInsideTheBar()
    {
        var bar = new FootprintBar(T0, 60_000);

        bar.Add(100, 5, buyerAggressor: true);   // running +5
        bar.Add(99, 8, buyerAggressor: false);   // running −3
        bar.Add(100, 2, buyerAggressor: true);   // running −1

        bar.MaxDelta.Should().Be(5);
        bar.MinDelta.Should().Be(-3);
        bar.Delta.Should().Be(-1);
    }

    [Fact]
    public void Add_ShouldSetOhlcFromTradeOrder_WhenPricesMove()
    {
        var bar = new FootprintBar(T0, 60_000);

        bar.Add(100, 1, true);
        bar.Add(104, 1, true);
        bar.Add(97, 1, false);
        bar.Add(101, 1, false);

        (bar.Open, bar.High, bar.Low, bar.Close).Should().Be((100L, 104L, 97L, 101L));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-3)]
    public void Add_ShouldIgnoreTrade_WhenQuantityIsNotPositive(long quantity)
    {
        var bar = new FootprintBar(T0, 60_000);

        bar.Add(100, quantity, buyerAggressor: true);

        bar.IsEmpty.Should().BeTrue();
        bar.Open.Should().BeNull();
        bar.Cells.Should().BeEmpty();
    }

    [Fact]
    public void CellAt_ShouldReturnAnEmptyCell_WhenPriceDidNotTrade()
    {
        var bar = TestData.Cells(T0, (100, 2, 3));

        bar.CellAt(105).Should().Be(new FootprintCell(105, 0, 0));
    }

    [Fact]
    public void EndMs_ShouldBeStartPlusDuration_WhenBarIsCreated()
    {
        var bar = new FootprintBar(T0, 60_000);

        bar.EndMs.Should().Be(T0 + 60_000);
        bar.IsEmpty.Should().BeTrue();
        (bar.MaxDelta, bar.MinDelta).Should().Be((0L, 0L));
    }
}
