using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Instruments;

// reference: REQUIREMENTS.md FR-10, FR-54, ARCHITECTURE.md D-4
public sealed class InstrumentCatalogTests
{
    [Theory]
    [InlineData("ES", 0.25)]
    [InlineData("MES", 0.25)]
    [InlineData("GC", 0.10)]
    [InlineData("MGC", 0.10)]
    [InlineData("CL", 0.01)]
    [InlineData("MCL", 0.01)]
    [InlineData("MNQ", 0.25)]
    [InlineData("6E", 0.00005)]
    [InlineData("ZN", 0.015625)]
    public void For_ShouldReturnTheSpecForTheRoot_WhenTheRootIsKnown(string rootName, double tickSize)
    {
        var root = InstrumentRoot.Parse(rootName);
        var spec = InstrumentCatalog.For(root);

        spec.Root.Should().Be(root);
        spec.TickSize.Should().Be((decimal)tickSize);
    }

    [Fact]
    public void For_ShouldThrow_WhenTheCatalogDoesNotListTheRoot()
    {
        var act = () => InstrumentCatalog.For(InstrumentRoot.Parse("ZZZ"));

        act.Should().Throw<ArgumentOutOfRangeException>();
    }

    [Fact]
    public void All_ShouldListEachRootOnce_InSectorOrder()
    {
        var all = InstrumentCatalog.All;

        all.Select(s => s.Root).Should().OnlyHaveUniqueItems();
        all.Select(s => InstrumentCatalog.SectorOrder(s.Sector)).Should().BeInAscendingOrder("the picker groups products by sector");
        all.Should().HaveCountGreaterThan(40, "the catalog covers the TopstepX product menu");
        all.Take(1).Single().Root.Should().Be(InstrumentRoot.ES);
    }

    [Fact]
    public void All_ShouldGiveEveryProductConsistentTickMetadata()
    {
        foreach (var spec in InstrumentCatalog.All)
        {
            spec.TickSize.Should().BePositive(spec.Root.Value);
            spec.TickValue.Should().BePositive(spec.Root.Value);
            spec.PriceDecimals.Should().Be(InstrumentCatalog.DecimalsFor(spec.TickSize), spec.Root.Value);
            spec.TpoRowTicks.Should().BePositive(spec.Root.Value);
            InstrumentCatalog.Sectors.Should().Contain(spec.Sector);
        }
    }

    [Fact]
    public void Core_ShouldBeTheMvpThreeWithTheirOriginalMetadata()
    {
        InstrumentCatalog.Core.Select(s => s.Root.Value).Should().Equal("ES", "GC", "CL");
        InstrumentCatalog.ES.ContractId.Should().Be("ESZ26");
        InstrumentCatalog.GC.TickValue.Should().Be(10.00m);
        InstrumentCatalog.CL.PriceDecimals.Should().Be(2);
    }

    [Theory]
    [InlineData(0.25, 2)]
    [InlineData(0.03125, 5)]
    [InlineData(0.0000005, 7)]
    [InlineData(5, 0)]
    [InlineData(1, 0)]
    public void DecimalsFor_ShouldShowEveryTickExactly(double tickSize, int expected)
    {
        InstrumentCatalog.DecimalsFor((decimal)tickSize).Should().Be(expected);
    }

    [Fact]
    public void Order_ShouldPutUnlistedRootsLast()
    {
        InstrumentCatalog.Order(InstrumentRoot.Parse("ZZZ")).Should().Be(InstrumentCatalog.All.Count);
        InstrumentCatalog.SectorOrder("Something else").Should().Be(InstrumentCatalog.Sectors.Count);
    }

    [Theory]
    [InlineData("ES", "ES")]
    [InlineData("es", "ES")]
    [InlineData("Gc", "GC")]
    [InlineData("MES", "MES")]
    [InlineData("mes", "MES")]
    [InlineData("Mgc", "MGC")]
    [InlineData("mcl", "MCL")]
    [InlineData("m6e", "M6E")]
    [InlineData("ZZZ", "ZZZ")]
    public void TryParse_ShouldParseAnyRootInAnyCase_WhenTheValueIsOneToSixLettersOrDigits(string value, string expected)
    {
        InstrumentCatalog.TryParse(value, out var root).Should().BeTrue();
        root.Value.Should().Be(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("ESZ26XX")]
    [InlineData("E-S")]
    [InlineData("ES ")]
    [InlineData("É")]
    public void TryParse_ShouldReturnFalse_WhenTheValueIsNotAnInstrumentRoot(string? value)
    {
        InstrumentCatalog.TryParse(value, out _).Should().BeFalse();
    }
}
