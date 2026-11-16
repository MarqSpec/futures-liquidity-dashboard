using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Indicators;

// reference: REQUIREMENTS.md FR-18
public sealed class SessionVwapTests
{
    [Fact]
    public void Value_ShouldBeNull_WhenNoVolumeWasAdded()
    {
        new SessionVwap().Value.Should().BeNull();
    }

    [Fact]
    public void Value_ShouldBeTheVolumeWeightedMeanAndDeviation_WhenTradesWereAdded()
    {
        // (100·1 + 102·3) / 4 = 101.5; variance 10303 − 101.5² = 0.75.
        var vwap = new SessionVwap();
        vwap.Add(100, 1);
        vwap.Add(102, 3);

        var value = vwap.Value!.Value;

        value.Vwap.Should().BeApproximately(101.5, 1e-9);
        value.StdDev.Should().BeApproximately(Math.Sqrt(0.75), 1e-9);
        value.Volume.Should().Be(4);
    }

    [Fact]
    public void Reset_ShouldClearTheAccumulationAndSetTheAnchor_WhenANewAnchorStarts()
    {
        var vwap = new SessionVwap();
        vwap.Add(100, 5);

        vwap.Reset("2026-11-10", partial: true);

        vwap.Value.Should().BeNull();
        vwap.AnchorId.Should().Be("2026-11-10");
        vwap.IsPartial.Should().BeTrue();
    }
}
