using MarqSpec.FuturesLiquidityDashboard.Core.Bars;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Bars;

// reference: REQUIREMENTS.md FR-14, NFR-4
public sealed class TradeDeduplicatorTests
{
    [Fact]
    public void Accept_ShouldRejectAndCountARepeatedId_WhenTheIdWasSeen()
    {
        var dedup = new TradeDeduplicator();

        var first = dedup.Accept("t1");
        var second = dedup.Accept("t1");

        (first, second, dedup.Duplicates).Should().Be((true, false, 1L));
    }

    [Fact]
    public void Accept_ShouldForgetTheOldestId_WhenTheCapacityIsExceeded()
    {
        var dedup = new TradeDeduplicator(capacity: 2);
        dedup.Accept("t1");
        dedup.Accept("t2");
        dedup.Accept("t3");

        dedup.Accept("t1").Should().BeTrue();
        dedup.Accept("t3").Should().BeFalse();
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    public void Accept_ShouldThrow_WhenTheIdIsMissing(string? tradeId)
    {
        var act = () => new TradeDeduplicator().Accept(tradeId!);

        act.Should().Throw<ArgumentException>();
    }
}
