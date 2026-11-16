using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Indicators;

// reference: REQUIREMENTS.md FR-18 — bands are the session VWAP plus and minus one and two standard deviations
public sealed class VwapBandsTests
{
    [Fact]
    public void From_ShouldPlaceTheBandsAtOneAndTwoDeviations_WhenTheVwapHasASpread()
    {
        var bands = VwapBands.From(new VwapValue(Vwap: 100, StdDev: 1.5, Volume: 10));

        bands.Should().Be(new VwapBands(Minus2: 97, Minus1: 98.5, Vwap: 100, Plus1: 101.5, Plus2: 103));
    }

    [Fact]
    public void From_ShouldCollapseTheBandsOntoTheVwap_WhenThereIsNoDeviation()
    {
        var bands = VwapBands.From(new VwapValue(Vwap: 40, StdDev: 0, Volume: 1));

        bands.Minus2.Should().Be(40);
        bands.Plus2.Should().Be(40);
    }
}
