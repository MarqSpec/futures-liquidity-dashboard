using MarqSpec.FuturesLiquidityDashboard.Core.Heatmap;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Heatmap;

// reference: REQUIREMENTS.md FR-12 — resampling adds integrals and known time, it never averages means
public sealed class HeatmapColumnTests
{
    [Fact]
    public void Combine_ShouldAddIntegralsAndKnownTime_WhenColumnsShareAPrice()
    {
        var first = new HeatmapColumn(0, 1000, [new HeatCell(100, BidQuantityMs: 10 * 1000, AskQuantityMs: 0, KnownMs: 1000)]);
        var second = new HeatmapColumn(1000, 1000, [new HeatCell(100, BidQuantityMs: 30 * 1000, AskQuantityMs: 0, KnownMs: 1000)]);

        var combined = HeatmapColumn.Combine(0, 2000, [first, second]);

        combined.DurationMs.Should().Be(2000);
        var cell = combined.Cells.Should().ContainSingle().Subject;
        cell.KnownMs.Should().Be(2000);
        cell.BidTimeWeighted.Should().BeApproximately(20, 1e-9);
    }
}
