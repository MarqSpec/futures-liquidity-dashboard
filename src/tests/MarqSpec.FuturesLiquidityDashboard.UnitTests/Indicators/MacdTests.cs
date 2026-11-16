using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Indicators;

// reference: REQUIREMENTS.md FR-20
public sealed class MacdTests
{
    [Fact]
    public void Update_ShouldReturnNull_WhenTheSlowEmaIsNotSeeded()
    {
        var macd = new Macd(2, 3, 2);

        macd.Update(10);

        macd.Update(12).Should().BeNull();
    }

    [Fact]
    public void Update_ShouldReturnTheLineWithoutASignal_WhenTheSignalEmaIsNotSeeded()
    {
        // EMA2 seeds at 11 and stays 11 on a close of 11; EMA3 seeds at 11 on the third close: line 0.
        var macd = new Macd(2, 3, 2);
        macd.Update(10);
        macd.Update(12);

        var value = macd.Update(11);

        value!.Value.Line.Should().BeApproximately(0, 1e-9);
        value.Value.Signal.Should().BeNull();
        value.Value.Histogram.Should().BeNull();
    }

    [Fact]
    public void Update_ShouldComputeLineSignalAndHistogram_WhenAllEmasAreSeeded()
    {
        // Closes 10, 12, 11, 15, 14 with 2/3/2: lines 0, 2/3, 7/18; signal seeds at 1/3, then 10/27.
        var macd = new Macd(2, 3, 2);
        foreach (var close in new double[] { 10, 12, 11, 15 })
        {
            macd.Update(close);
        }

        var value = macd.Update(14)!.Value;

        value.Line.Should().BeApproximately(7.0 / 18, 1e-9);
        value.Signal.Should().BeApproximately(10.0 / 27, 1e-9);
        value.Histogram.Should().BeApproximately(1.0 / 54, 1e-9);
    }

    [Theory]
    [InlineData(26, 26)]
    [InlineData(27, 26)]
    public void Constructor_ShouldThrow_WhenTheFastPeriodIsNotShorterThanTheSlow(int fast, int slow)
    {
        var act = () => new Macd(fast, slow, 9);

        act.Should().Throw<ArgumentException>();
    }
}
