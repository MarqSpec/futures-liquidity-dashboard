using MarqSpec.FuturesLiquidityDashboard.Core.Bars;
using MarqSpec.FuturesLiquidityDashboard.Core.Regime;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Regime;

// reference: REQUIREMENTS.md FR-75, FR-56
public sealed class RangeZoneBuilderTests
{
    private const int BarMs = 900_000;
    private static readonly long T0 = TestData.EpochMs - (TestData.EpochMs % BarMs);

    [Fact]
    public void Add_ShouldGiveTwoZones_WhenARangingRunIsBrokenByOneTransitionBar()
    {
        // Given three Ranging bars, one Transition bar, then two more Ranging bars
        var builder = new RangeZoneBuilder();
        builder.Add(Bar(0, low: 100, high: 110), TrendRegime.Ranging);
        builder.Add(Bar(1, low: 98, high: 108), TrendRegime.Ranging);
        builder.Add(Bar(2, low: 101, high: 112), TrendRegime.Ranging);
        builder.Add(Bar(3, low: 90, high: 130), TrendRegime.Transition);
        builder.Add(Bar(4, low: 120, high: 125), TrendRegime.Ranging);
        builder.Add(Bar(5, low: 118, high: 124), TrendRegime.Ranging);

        // Then the Transition bar splits them, and each zone spans its own bars' time, lowest low and highest high
        builder.Zones.Should().Equal(
            new RangeZoneDto(Start(0), Start(3), 98, 112),
            new RangeZoneDto(Start(4), Start(6), 118, 125));
    }

    [Theory]
    [InlineData(TrendRegime.Unknown)]
    [InlineData(TrendRegime.Transition)]
    [InlineData(TrendRegime.TrendingUp)]
    [InlineData(TrendRegime.TrendingDown)]
    public void Add_ShouldEndTheZone_WhenABarOfAnyOtherClassCloses(TrendRegime other)
    {
        var builder = new RangeZoneBuilder();
        builder.Add(Bar(0, 100, 110), TrendRegime.Ranging);
        builder.Add(Bar(1, 100, 110), other);
        builder.Add(Bar(2, 100, 110), TrendRegime.Ranging);

        builder.Zones.Should().HaveCount(2);
        builder.Zones[0].EndMs.Should().Be(Start(1));
    }

    [Fact]
    public void Add_ShouldNeverShade_WhenNoBarIsRanging()
    {
        var builder = new RangeZoneBuilder();
        builder.Add(Bar(0, 100, 110), TrendRegime.Unknown);
        builder.Add(Bar(1, 100, 110), TrendRegime.TrendingUp);

        builder.Zones.Should().BeEmpty();
        builder.Version.Should().Be(0);
    }

    [Fact]
    public void Add_ShouldEndTheZone_WhenABarWithNoTradesCloses()
    {
        // An empty bar is skipped by the regime rule, so the class it would carry is not a classification of that time
        var builder = new RangeZoneBuilder();
        builder.Add(Bar(0, 100, 110), TrendRegime.Ranging);
        builder.Add(TradeBar.Empty(Start(1), BarMs), TrendRegime.Ranging);
        builder.Add(Bar(2, 100, 110), TrendRegime.Ranging);

        builder.Zones.Select(z => (z.StartMs, z.EndMs)).Should().Equal((Start(0), Start(1)), (Start(2), Start(3)));
    }

    [Fact]
    public void Add_ShouldGrowTheLiveZone_WhenEachRangingBarCloses()
    {
        var builder = new RangeZoneBuilder();
        builder.Add(Bar(0, 100, 110), TrendRegime.Ranging);
        var first = builder.Version;
        builder.Zones.Should().ContainSingle().Which.EndMs.Should().Be(Start(1));

        builder.Add(Bar(1, 95, 105), TrendRegime.Ranging);

        builder.Zones.Should().ContainSingle().Which.Should().Be(new RangeZoneDto(Start(0), Start(2), 95, 110));
        builder.Version.Should().BeGreaterThan(first);
    }

    [Fact]
    public void Add_ShouldStartANewZone_WhenTheNextRangingBarIsNotContiguous()
    {
        var builder = new RangeZoneBuilder();
        builder.Add(Bar(0, 100, 110), TrendRegime.Ranging);
        builder.Add(Bar(2, 100, 110), TrendRegime.Ranging);

        builder.Zones.Should().HaveCount(2);
    }

    [Fact]
    public void Trim_ShouldDropZonesThatEndedBeforeTheRetainedBars_AndKeepTheRest()
    {
        var builder = new RangeZoneBuilder();
        builder.Add(Bar(0, 100, 110), TrendRegime.Ranging);
        builder.Add(Bar(1, 100, 110), TrendRegime.Transition);
        builder.Add(Bar(2, 100, 110), TrendRegime.Ranging);
        builder.Add(Bar(3, 100, 110), TrendRegime.Ranging);
        var before = builder.Version;

        builder.Trim(Start(1));

        builder.Zones.Should().ContainSingle().Which.StartMs.Should().Be(Start(2));
        builder.Version.Should().BeGreaterThan(before);
    }

    [Fact]
    public void Trim_ShouldKeepAZone_WhenItEndsAfterTheCutoff()
    {
        var builder = new RangeZoneBuilder();
        builder.Add(Bar(0, 100, 110), TrendRegime.Ranging);
        builder.Add(Bar(1, 100, 110), TrendRegime.Ranging);
        var before = builder.Version;

        builder.Trim(Start(2) - 1);

        builder.Zones.Should().ContainSingle();
        builder.Version.Should().Be(before, "nothing changed, so nothing needs sending again");
    }

    [Fact]
    public void Trim_ShouldNotExtendATrimmedZone_WhenTheNextRangingBarCloses()
    {
        var builder = new RangeZoneBuilder();
        builder.Add(Bar(0, 100, 110), TrendRegime.Ranging);
        builder.Trim(Start(1));

        builder.Add(Bar(1, 100, 110), TrendRegime.Ranging);

        builder.Zones.Should().ContainSingle().Which.StartMs.Should().Be(Start(1));
    }

    private static long Start(int index) => T0 + (index * (long)BarMs);

    private static TradeBar Bar(int index, long low, long high) => TradeBar.Empty(Start(index), BarMs)
        .With(low, 1, buyerAggressor: false)
        .With(high, 1, buyerAggressor: true);
}
