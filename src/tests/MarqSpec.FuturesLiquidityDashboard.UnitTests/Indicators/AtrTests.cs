using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Indicators;

// reference: REQUIREMENTS.md FR-21
public sealed class AtrTests
{
    [Fact]
    public void Update_ShouldSeedWithTheMeanTrueRange_WhenThePeriodIsReached()
    {
        // True ranges 2, 2, 3 → 7/3.
        var atr = new Atr(3);
        atr.Update(10, 8, 9).Should().BeNull();
        atr.Update(11, 9, 10).Should().BeNull();

        atr.Update(12, 9, 11).Should().BeApproximately(7.0 / 3, 1e-9);
    }

    [Fact]
    public void Update_ShouldApplyWildersSmoothing_WhenAlreadySeeded()
    {
        // A gap bar: true range max(2, |15 − 11|, |13 − 11|) = 4 → (7/3 · 2 + 4) / 3 = 26/9.
        var atr = new Atr(3);
        atr.Update(10, 8, 9);
        atr.Update(11, 9, 10);
        atr.Update(12, 9, 11);

        atr.Update(15, 13, 14).Should().BeApproximately(26.0 / 9, 1e-9);
    }

    [Theory]
    [InlineData(12.0, 10.0, null, 2.0)]
    [InlineData(12.0, 10.0, 11.0, 2.0)]
    [InlineData(12.0, 10.0, 7.0, 5.0)]
    [InlineData(12.0, 10.0, 15.0, 5.0)]
    public void TrueRange_ShouldIncludeGapsFromThePreviousClose_WhenOneIsKnown(double high, double low, double? previousClose, double expected)
    {
        Atr.TrueRange(high, low, previousClose).Should().Be(expected);
    }

    [Fact]
    public void Developing_ShouldReturnNull_WhenNotSeeded()
    {
        var atr = new Atr(3);
        atr.Update(10, 8, 9);

        atr.Developing(11, 9).Should().BeNull();
    }
}
