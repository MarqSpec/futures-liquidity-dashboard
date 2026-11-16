using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-50, ARCHITECTURE.md D-24
public sealed class ProfileNodesTests
{
    private static readonly long[] Peak = [2, 4, 10, 25, 50, 80, 100, 80, 50, 25, 10, 4, 2];

    [Fact]
    public void Find_ShouldReportBothPeaksAsHighVolumeNodes_WhenTheProfileIsBimodal()
    {
        var nodes = ProfileNodes.Find(Bimodal(), OrderFlowOptions.Default);

        nodes.Where(n => n.IsHigh).Select(n => n.PriceTicks).Should().Equal(110, 130);
    }

    [Fact]
    public void Find_ShouldReportTheValleyAsALowVolumeNode_WhenTheProfileIsBimodal()
    {
        // The 5-tick smoothing turns the 117–123 trough into a 0.8 plateau over 119–121; plateaus report their lowest price.
        var nodes = ProfileNodes.Find(Bimodal(), OrderFlowOptions.Default);

        nodes.Where(n => !n.IsHigh).Should().ContainSingle().Which.Should().Be(new VolumeNode(119, 0.8, IsHigh: false));
    }

    [Fact]
    public void Find_ShouldNotCallTheThinEdgesNodes_WhenTheProfileTapersOff()
    {
        var nodes = ProfileNodes.Find(Bimodal(), OrderFlowOptions.Default);

        nodes.Should().NotContain(n => n.PriceTicks < 110 || n.PriceTicks > 130);
    }

    [Fact]
    public void Find_ShouldReturnNothing_WhenThereAreFewerThanFiveBins()
    {
        var bins = Enumerable.Range(100, 4).Select(p => new KeyValuePair<long, long>(p, p == 101 ? 100 : 1)).ToList();

        ProfileNodes.Find(bins, OrderFlowOptions.Default).Should().BeEmpty();
    }

    [Fact]
    public void Find_ShouldReturnNothing_WhenTheProfileIsUniform()
    {
        var bins = Enumerable.Range(100, 10).Select(p => new KeyValuePair<long, long>(p, 10)).ToList();

        ProfileNodes.Find(bins, OrderFlowOptions.Default).Should().BeEmpty();
    }

    [Fact]
    public void Find_ShouldReturnNothing_WhenTheRangeIsWiderThanTwentyThousandTicks()
    {
        var bins = Bimodal().Append(new KeyValuePair<long, long>(30_000, 1)).ToList();

        ProfileNodes.Find(bins, OrderFlowOptions.Default).Should().BeEmpty();
    }

    /// <summary>Peaks of 100 at 110 and 130 over 104–136, with a near-empty trough (0 at 120) between them.</summary>
    private static List<KeyValuePair<long, long>> Bimodal()
    {
        var bins = new List<KeyValuePair<long, long>>();
        bins.AddRange(Peak.Select((v, i) => new KeyValuePair<long, long>(104 + i, v)));
        bins.AddRange(new long[] { 1, 1, 1, 0, 1, 1, 1 }.Select((v, i) => new KeyValuePair<long, long>(117 + i, v)));
        bins.AddRange(Peak.Select((v, i) => new KeyValuePair<long, long>(124 + i, v)));
        return bins;
    }
}
