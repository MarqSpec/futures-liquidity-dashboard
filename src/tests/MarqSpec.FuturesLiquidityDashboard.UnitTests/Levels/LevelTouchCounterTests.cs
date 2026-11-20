using MarqSpec.FuturesLiquidityDashboard.Core.Levels;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Levels;

// reference: a third-touch bounce is a return to a level after price has left it
// (held or broke, REQUIREMENTS.md FR-79, ARCHITECTURE.md D-65)
public sealed class LevelTouchCounterTests
{
    private static (long TimeMs, long Low, long High, long? Close) Bar(long t, long low, long high, long? close = null) => (t, low, high, close);

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

    [Fact]
    public void Count_ShouldCountTheTouchAsHeld_WhenNoLaterBarClosesTwoTicksBeyond()
    {
        // Given price rises to a high at 100 and the furthest close beyond it is one tick
        var bars = new[] { Bar(1, 94, 96, 95), Bar(2, 98, 101, 101), Bar(3, 99, 101, 99), Bar(4, 93, 96, 94) };

        // When the touch is counted
        var level = LevelTouchCounter.Count("PDH", 100, isHigh: true, bars, proximityTicks: 1);

        // Then it held
        level.Should().BeEquivalentTo(new { Touches = 1, Held = 1, Broke = 0 });
    }

    [Fact]
    public void Count_ShouldCountTheTouchAsBroke_WhenALaterBarClosesExactlyTwoTicksBeyond()
    {
        var bars = new[] { Bar(1, 94, 96, 95), Bar(2, 98, 101, 99), Bar(3, 100, 103, 102) };

        var level = LevelTouchCounter.Count("PDH", 100, isHigh: true, bars, proximityTicks: 1);

        level.Should().BeEquivalentTo(new { Touches = 1, Held = 0, Broke = 1 });
    }

    [Fact]
    public void Count_ShouldCountTheTouchAsBroke_WhenTheTouchBarItselfClosesTwoTicksBeyond()
    {
        var bars = new[] { Bar(1, 94, 96, 95), Bar(2, 99, 103, 103) };

        LevelTouchCounter.Count("PDH", 100, isHigh: true, bars, proximityTicks: 1).Broke.Should().Be(1);
    }

    [Fact]
    public void Count_ShouldJudgeBeyondFromTheSidePriceCameFrom_WhenALowLevelIsReachedFromBelow()
    {
        // Given a low level that price reaches from below and closes two ticks above
        var bars = new[] { Bar(1, 94, 96, 95), Bar(2, 99, 101, 100), Bar(3, 101, 103, 102) };

        // When the touch is counted
        var level = LevelTouchCounter.Count("Asia low", 100, isHigh: false, bars, proximityTicks: 1);

        // Then the close above is beyond it, because that is the far side from the approach
        level.Should().BeEquivalentTo(new { Held = 0, Broke = 1 });
    }

    [Fact]
    public void Count_ShouldNotCountACloseOnTheApproachSide_WhenPriceFallsBackAway()
    {
        // Given price reaches a low level from above and closes two ticks above it on the way back up
        var bars = new[] { Bar(1, 104, 106, 105), Bar(2, 99, 101, 100), Bar(3, 101, 103, 102) };

        LevelTouchCounter.Count("Asia low", 100, isHigh: false, bars, proximityTicks: 1)
            .Should().BeEquivalentTo(new { Held = 1, Broke = 0 });
    }

    [Fact]
    public void Count_ShouldUseTheLevelSide_WhenTheFirstBarIsAlreadyOnTheLevel()
    {
        var bars = new[] { Bar(1, 99, 101, 100), Bar(2, 100, 103, 102) };

        var high = LevelTouchCounter.Count("Session high", 100, isHigh: true, bars, proximityTicks: 1);
        var low = LevelTouchCounter.Count("Session low", 100, isHigh: false, bars, proximityTicks: 1);

        new[] { high.Broke, low.Broke }.Should().Equal(1, 0);
    }

    [Fact]
    public void Count_ShouldNotBreakOnTheDevelopingBar_WhenItHasNotClosed()
    {
        var bars = new[] { Bar(1, 94, 96, 95), Bar(2, 98, 101, 99), Bar(3, 100, 105) };

        LevelTouchCounter.Count("PDH", 100, isHigh: true, bars, proximityTicks: 1)
            .Should().BeEquivalentTo(new { Held = 1, Broke = 0 });
    }

    [Fact]
    public void Count_ShouldJudgeEachTouchOnItsOwnBars_WhenPriceReturnsAndThenBreaks()
    {
        // Given a first touch that falls away and a second that closes through
        var bars = new[]
        {
            Bar(1, 94, 96, 95),
            Bar(2, 99, 101, 99),
            Bar(3, 92, 95, 93),
            Bar(4, 99, 101, 100),
            Bar(5, 101, 104, 103),
        };

        // When the touches are counted
        var level = LevelTouchCounter.Count("PDH", 100, isHigh: true, bars, proximityTicks: 1);

        // Then the first held and the second broke
        level.Should().BeEquivalentTo(new { Touches = 2, Held = 1, Broke = 1 });
    }

    [Fact]
    public void Count_ShouldCountNoOutcome_WhenNoBarReachesTheLevel()
    {
        var bars = new[] { Bar(1, 90, 92, 91), Bar(2, 110, 112, 111) };

        LevelTouchCounter.Count("PDH", 100, isHigh: true, bars, proximityTicks: 1)
            .Should().BeEquivalentTo(new { Touches = 0, Held = 0, Broke = 0 });
    }
}
