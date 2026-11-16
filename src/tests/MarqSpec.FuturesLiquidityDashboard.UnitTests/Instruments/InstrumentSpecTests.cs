using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Instruments;

// reference: REQUIREMENTS.md FR-5
public sealed class InstrumentSpecTests
{
    [Theory]
    [InlineData("ES", "6000.25", 24_001)]
    [InlineData("MES", "6000.25", 24_001)]
    [InlineData("GC", "2650.1", 26_501)]
    [InlineData("MGC", "2650.1", 26_501)]
    [InlineData("CL", "75.43", 7_543)]
    [InlineData("MCL", "75.43", 7_543)]
    public void ToTicks_ShouldReturnTheIntegerTickKey_WhenThePriceIsOnTheGrid(string rootName, string price, long ticks)
    {
        var root = InstrumentRoot.Parse(rootName);
        InstrumentCatalog.For(root).ToTicks(Price(price)).Should().Be(ticks);
    }

    [Fact]
    public void ToTicks_ShouldThrowInvalidPriceIncrement_WhenThePriceIsOffTheGrid()
    {
        var act = () => InstrumentCatalog.MES.ToTicks(6000.10m);

        act.Should().Throw<InvalidPriceIncrementException>().WithMessage("Price 6000.10 is not a multiple of tick size 0.25 for MESZ26.");
    }

    [Theory]
    [InlineData("6000.25", true)]
    [InlineData("6000.10", false)]
    [InlineData("6000.125", false)]
    public void TryToTicks_ShouldReportWhetherThePriceIsOnTheGrid_WhenConverting(string price, bool valid)
    {
        InstrumentCatalog.MES.TryToTicks(Price(price), out _).Should().Be(valid);
    }

    [Theory]
    [InlineData("ES", 24_001, "6000.25")]
    [InlineData("MES", 24_001, "6000.25")]
    [InlineData("GC", 26_501, "2650.1")]
    [InlineData("MGC", 26_501, "2650.1")]
    [InlineData("CL", 7_540, "75.40")]
    [InlineData("MCL", 7_540, "75.40")]
    public void Format_ShouldUseTheContractsDecimals_WhenFormattingATickKey(string rootName, long ticks, string expected)
    {
        var root = InstrumentRoot.Parse(rootName);
        InstrumentCatalog.For(root).Format(ticks).Should().Be(expected);
    }

    [Fact]
    public void ToPrice_ShouldMultiplyByTheTickSize_WhenGivenATickKey()
    {
        InstrumentCatalog.MES.ToPrice(24_001).Should().Be(6000.25m);
    }

    private static decimal Price(string text) => decimal.Parse(text, System.Globalization.CultureInfo.InvariantCulture);
}
