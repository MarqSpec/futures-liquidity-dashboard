using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Indicators;

// reference: REQUIREMENTS.md FR-19
public sealed class RsiTests
{
    [Fact]
    public void Update_ShouldStayUnready_WhenFewerThanPeriodChangesWereSeen()
    {
        var rsi = new Rsi(3);

        var values = new double[] { 10, 11, 12 }.Select(c => rsi.Update(c)).ToList();

        values.Should().AllSatisfy(v => v.Should().BeNull());
    }

    [Fact]
    public void Update_ShouldSeedWithSimpleAverages_WhenThePeriodIsReached()
    {
        // Changes +1, +1, −1: average gain 2/3, average loss 1/3, RS 2 → 66.67.
        var rsi = new Rsi(3);

        var value = new double[] { 10, 11, 12, 11 }.Select(c => rsi.Update(c)).ToList()[^1];

        value.Should().BeApproximately(100 - (100 / 3.0), 1e-9);
    }

    [Fact]
    public void Update_ShouldApplyWildersSmoothing_WhenAlreadySeeded()
    {
        // Next change +2: gain (2/3·2 + 2)/3 = 10/9, loss (1/3·2)/3 = 2/9, RS 5 → 83.33.
        var rsi = new Rsi(3);

        var value = new double[] { 10, 11, 12, 11, 13 }.Select(c => rsi.Update(c)).ToList()[^1];

        value.Should().BeApproximately(100 - (100 / 6.0), 1e-9);
    }

    [Theory]
    [InlineData(new double[] { 1, 2, 3, 4 }, 100.0)]
    [InlineData(new double[] { 5, 5, 5, 5 }, 50.0)]
    [InlineData(new double[] { 4, 3, 2, 1 }, 0.0)]
    public void Update_ShouldHandleOneSidedChanges_WhenThereAreNoLossesOrNoGains(double[] closes, double expected)
    {
        var rsi = new Rsi(3);

        closes.Select(c => rsi.Update(c)).ToList()[^1].Should().Be(expected);
    }

    [Fact]
    public void Developing_ShouldReturnNull_WhenNotReady()
    {
        var rsi = new Rsi(3);
        rsi.Update(10);

        rsi.Developing(11).Should().BeNull();
    }
}
