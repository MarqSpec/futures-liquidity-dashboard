using MarqSpec.FuturesLiquidityDashboard.Core.Levels;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Levels;

// reference: a third-touch bounce is a return to a level after price has left it
public sealed class LevelTouchCounterTests
{
    private static (long TimeMs, long Low, long High) Bar(long t, long low, long high) => (t, low, high);

    [Fact]
    public void TouchTimes_ShouldCountOneTouch_WhenPriceStaysOnTheLevel()
    {
        var bars = new[] { Bar(1, 98, 102), Bar(2, 99, 101), Bar(3, 100, 103) };

        LevelTouchCounter.TouchTimes(bars, 100).Should().Equal(1L);
    }

    [Fact]
    public void TouchTimes_ShouldCountEachReturn_WhenPriceLeavesAndComesBack()
    {
        var bars = new[]
        {
            Bar(1, 100, 101),
            Bar(2, 110, 112),
            Bar(3, 99, 100),
            Bar(4, 90, 92),
            Bar(5, 100, 104),
        };

        LevelTouchCounter.TouchTimes(bars, 100, proximityTicks: 1).Should().Equal(1L, 3L, 5L);
    }

    [Fact]
    public void Count_ShouldMarkTheThirdTouch_WhenPriceHasReturnedTwice()
    {
        var bars = new[]
        {
            Bar(1, 100, 100),
            Bar(2, 120, 121),
            Bar(3, 100, 100),
            Bar(4, 80, 81),
            Bar(5, 99, 101),
        };

        var level = LevelTouchCounter.Count("VAL", 100, isHigh: false, bars, proximityTicks: 1);

        level.Touches.Should().Be(3);
        level.IsThirdTouch.Should().BeTrue();
        level.LastTouchMs.Should().Be(5);
    }

    [Fact]
    public void Count_ShouldNotMarkAThirdTouch_WhenOnlyTwoApproachesHaveLanded()
    {
        var bars = new[] { Bar(1, 100, 100), Bar(2, 120, 121), Bar(3, 100, 100) };

        LevelTouchCounter.Count("VAH", 100, isHigh: true, bars, proximityTicks: 0).IsThirdTouch.Should().BeFalse();
    }

    [Fact]
    public void Count_ShouldKeepTheThirdTouchFlag_WhenTheLevelCarriesASession()
    {
        var bars = new[]
        {
            Bar(1, 100, 100),
            Bar(2, 120, 121),
            Bar(3, 100, 100),
            Bar(4, 80, 81),
            Bar(5, 99, 101),
        };

        var level = LevelTouchCounter.Count("PDH", 100, isHigh: true, bars, proximityTicks: 1, sessionId: "2026-11-09", asOfMs: 50);

        level.IsThirdTouch.Should().BeTrue();
        level.SessionId.Should().Be("2026-11-09");
        level.AsOfMs.Should().Be(50);
    }

    [Fact]
    public void TouchTimes_ShouldIgnoreABar_WhenItsRangeIsInverted()
    {
        var bars = new[] { Bar(1, 110, 90), Bar(2, 100, 100) };

        LevelTouchCounter.TouchTimes(bars, 100, proximityTicks: 0).Should().Equal(2L);
    }
}
