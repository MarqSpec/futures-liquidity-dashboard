using MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Liquidity;

// (REQUIREMENTS.md FR-83, ARCHITECTURE.md D-70)
public sealed class TapeActivityTests
{
    private const long TenSeconds = 10_000;
    private const long ThirtyMinutes = 30 * 60_000;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Reading_ShouldBeUnknownWithNoBaseline_WhenLessThanThirtyMinutesHaveBeenSeen()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        Steady(tape, T0, ThirtyMinutes - TenSeconds, perTenSeconds: 40);

        var reading = tape.Reading();

        reading.State.Should().Be(TapeState.Unknown);
        (reading.BaselineRate, reading.ThinBelowRate).Should().Be((null, null));
    }

    [Fact]
    public void Reading_ShouldBeThinWithTheMedianAndTheLimit_WhenTheRateFallsUnderAQuarterOfTheThirtyMinuteMedian()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        Steady(tape, T0, ThirtyMinutes, perTenSeconds: 40);
        tape.Add(T0 + ThirtyMinutes + 5_000, 1);
        tape.AdvanceTo(T0 + ThirtyMinutes + 9_999);

        var reading = tape.Reading();

        reading.State.Should().Be(TapeState.Thin);
        reading.Rate.Should().Be(0.1);
        reading.BaselineRate.Should().Be(4.0);
        reading.ThinBelowRate.Should().Be(1.0);
        reading.BaselineMinutes.Should().Be(30);
    }

    [Fact]
    public void Reading_ShouldBeActive_WhenTheRateIsExactlyAQuarterOfTheMedian()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        Steady(tape, T0, ThirtyMinutes, perTenSeconds: 40);
        tape.Add(T0 + ThirtyMinutes + 5_000, 10);
        tape.AdvanceTo(T0 + ThirtyMinutes + 9_999);

        var reading = tape.Reading();

        reading.Rate.Should().Be(1.0);
        reading.State.Should().Be(TapeState.Active, "thin is strictly under the limit");
    }

    [Fact]
    public void Reading_ShouldCountOnlyTheLastTenSecondsInTheRate_WhenOlderPrintsAreInsideTheBucket()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        Steady(tape, T0, ThirtyMinutes, perTenSeconds: 40);
        tape.Add(T0 + ThirtyMinutes + 1_000, 30);
        tape.AdvanceTo(T0 + ThirtyMinutes + 11_000);

        var reading = tape.Reading();

        reading.Rate.Should().Be(0, "the print is 10 s old, outside FR-39's window");
        reading.State.Should().Be(TapeState.Thin);
    }

    [Fact]
    public void Reading_ShouldJudgeAgainstTheMedianNotTheMean_WhenAFewTenSecondSpansSpike()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        Steady(tape, T0, ThirtyMinutes, perTenSeconds: 20);
        for (var i = 0; i < 10; i++)
        {
            tape.Add(T0 + (i * 60_000) + 1, 2_000);
        }

        tape.Add(T0 + ThirtyMinutes + 5_000, 10);
        tape.AdvanceTo(T0 + ThirtyMinutes + 9_999);

        var reading = tape.Reading();

        reading.BaselineRate.Should().Be(2.0, "ten spikes among 180 spans do not move the median");
        reading.State.Should().Be(TapeState.Active, "1.0/s is above a quarter of 2.0/s; the mean (about 13/s) would call it thin");
    }

    [Fact]
    public void Reading_ShouldBeUnknown_WhenMoreThanHalfOfTheWindowHadNoPrints()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        tape.AdvanceTo(T0);
        for (var i = 0; i < 80; i++)
        {
            tape.Add(T0 + (i * TenSeconds), 40);
        }

        tape.AdvanceTo(T0 + ThirtyMinutes + 5_000);

        var reading = tape.Reading();

        reading.State.Should().Be(TapeState.Unknown, "a zero median has nothing for a rate to be under");
        (reading.BaselineRate, reading.ThinBelowRate).Should().Be((null, null));
    }

    [Fact]
    public void Reading_ShouldForgetSpansOlderThanTheWindow_WhenTheTapeStaysQuietForAnotherThirtyMinutes()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        Steady(tape, T0, ThirtyMinutes, perTenSeconds: 40);
        Steady(tape, T0 + ThirtyMinutes, ThirtyMinutes, perTenSeconds: 4);
        tape.Add(T0 + (2 * ThirtyMinutes) + 5_000, 4);
        tape.AdvanceTo(T0 + (2 * ThirtyMinutes) + 9_999);

        var reading = tape.Reading();

        reading.BaselineRate.Should().Be(0.4, "the busy half hour has left the window");
        reading.State.Should().Be(TapeState.Active);
    }

    [Fact]
    public void Reading_ShouldHaveNoBaseline_WhenTheLastThirtyMinutesWereSilentAfterABusyHalfHour()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        Steady(tape, T0, ThirtyMinutes, perTenSeconds: 40);
        tape.AdvanceTo(T0 + (2 * ThirtyMinutes) + 5_000);

        var reading = tape.Reading();

        reading.State.Should().Be(TapeState.Unknown, "a silent half hour, such as the daily break, leaves a zero median");
    }

    [Fact]
    public void Reading_ShouldUseTheConfiguredWindowAndShare_WhenTheyDifferFromTheDefaults()
    {
        var tape = new TapeActivity(new TapeOptions { BaselineMinutes = 5, ThinRatio = 0.5 });
        Steady(tape, T0, 5 * 60_000, perTenSeconds: 40);
        tape.Add(T0 + (5 * 60_000) + 5_000, 15);
        tape.AdvanceTo(T0 + (5 * 60_000) + 9_999);

        var reading = tape.Reading();

        reading.ThinBelowRate.Should().Be(2.0);
        reading.BaselineMinutes.Should().Be(5);
        reading.State.Should().Be(TapeState.Thin, "1.5/s is under half of 4.0/s");
    }

    [Fact]
    public void Reading_ShouldLeaveOutALatePrintOlderThanTenSeconds_WhenItQueuedBehindANewerOne()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        Steady(tape, T0, ThirtyMinutes, perTenSeconds: 40);
        var t = T0 + ThirtyMinutes;
        tape.Add(t + 9_000, 10);
        tape.Add(t + 1_000, 30);
        tape.AdvanceTo(t + 11_500);

        var reading = tape.Reading();

        reading.Rate.Should().Be(1.0, "the late print at +1 s left the 10 s window at +11 s, though a newer print is ahead of it");
    }

    [Fact]
    public void Reading_ShouldRecomputeTheMedian_WhenALatePrintLandsInAFinishedSpan()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        tape.AdvanceTo(T0);
        for (var span = 0; span < 180; span += 2)
        {
            tape.Add(T0 + (span * TenSeconds), 40);
        }

        tape.AdvanceTo(T0 + ThirtyMinutes + 5_000);
        var before = tape.Reading().BaselineRate;

        tape.Add(T0 + (179 * TenSeconds) + 1, 40);

        (before, tape.Reading().BaselineRate).Should().Be((2.0, 4.0), "the late print turns the last empty span into a 40, which moves the median of 90 and 90");
    }

    [Fact]
    public void Reading_ShouldBeUnknown_WhenTheLastWarmupPrintIsInsideTheTenSecondWindow()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        tape.AdvanceTo(T0);
        for (var t = T0; t <= T0 + ThirtyMinutes; t += TenSeconds)
        {
            tape.Add(t, 40, live: false);
        }

        var lastWarmup = T0 + ThirtyMinutes;
        tape.AdvanceTo(lastWarmup + TenSeconds - 1);
        var inside = tape.Reading();
        tape.AdvanceTo(lastWarmup + TenSeconds);
        var past = tape.Reading();

        inside.State.Should().Be(TapeState.Unknown, "a live rate over a window that still holds warmup would read 0 and call the tape thin");
        (inside.BaselineRate, inside.ThinBelowRate).Should().Be((null, null));
        (inside.Rate, past.Rate).Should().Be((0, 0), "the rate is FR-39's, live prints only; warmup fills only the baseline");
        past.State.Should().Be(TapeState.Thin, "10 s after the last warmup print the rate is a full live window, here empty");
    }

    [Fact]
    public void Reading_ShouldReadActiveAgain_WhenTheRateRecovers()
    {
        var tape = new TapeActivity(TapeOptions.Default);
        Steady(tape, T0, ThirtyMinutes, perTenSeconds: 40);
        tape.AdvanceTo(T0 + ThirtyMinutes + 9_999);
        var thin = tape.Reading().State;

        tape.Add(T0 + ThirtyMinutes + 10_000, 40);

        (thin, tape.Reading().State).Should().Be((TapeState.Thin, TapeState.Active));
    }

    /// <summary>One print of <paramref name="perTenSeconds"/> contracts at the start of each 10 s span from <paramref name="fromMs"/>.</summary>
    private static void Steady(TapeActivity tape, long fromMs, long spanMs, long perTenSeconds)
    {
        tape.AdvanceTo(fromMs);
        for (var t = fromMs; t < fromMs + spanMs; t += TenSeconds)
        {
            tape.Add(t, perTenSeconds);
        }
    }
}
