using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Indicators;

// reference: REQUIREMENTS.md FR-17
public sealed class EmaTests
{
    [Fact]
    public void Update_ShouldStayUnready_WhenFewerThanPeriodClosesWereSeen()
    {
        var ema = new Ema(3);

        ema.Update(1);
        ema.Update(2);

        ema.IsReady.Should().BeFalse();
        ema.Value.Should().BeNull();
        ema.Count.Should().Be(2);
    }

    [Fact]
    public void Update_ShouldSeedWithTheSimpleAverage_WhenThePeriodIsReached()
    {
        var ema = new Ema(3);

        ema.Update(1);
        ema.Update(2);

        ema.Update(3).Should().Be(2.0);
    }

    [Fact]
    public void Update_ShouldApplyTheSmoothingFactor_WhenAlreadySeeded()
    {
        // alpha = 2 / (3 + 1) = 0.5: 2 → 3 → 4.
        var ema = new Ema(3);
        foreach (var close in new double[] { 1, 2, 3, 4 })
        {
            ema.Update(close);
        }

        ema.Update(5).Should().Be(4.0);
    }

    [Fact]
    public void Developing_ShouldNotChangeClosedState_WhenAskedForAProvisionalValue()
    {
        var ema = new Ema(3);
        foreach (var close in new double[] { 1, 2, 3 })
        {
            ema.Update(close);
        }

        var developing = ema.Developing(6);

        developing.Should().Be(4.0);
        ema.Value.Should().Be(2.0);
    }

    [Fact]
    public void Constructor_ShouldThrow_WhenPeriodIsBelowOne()
    {
        var act = () => new Ema(0);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}
