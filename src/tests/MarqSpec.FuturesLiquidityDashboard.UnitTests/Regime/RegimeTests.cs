using MarqSpec.FuturesLiquidityDashboard.Core.Regime;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Regime;

// reference: REQUIREMENTS.md FR-56
public sealed class RegimeTests
{
    private const int Bar = 300;
    private static readonly long T0 = TestData.EpochMs - (TestData.EpochMs % (Bar * 1000L));

    [Fact]
    public void Adx_ShouldBeUnready_UntilTwicePeriodBars_ThenStrongInAStraightTrend()
    {
        var adx = new Adx(3);
        for (var i = 0; i < 5; i++)
        {
            adx.Update(100 + i + 1, 100 + i - 1, 100 + i).Should().BeNull();
        }

        adx.Update(106, 104, 105).Should().NotBeNull();
        adx.Value.Should().BeApproximately(100, 1e-9, "every move is up, so −DM is zero and DX is 100");
        adx.PlusDi.Should().BeGreaterThan(adx.MinusDi!.Value);
    }

    [Fact]
    public void EfficiencyRatio_ShouldBeOne_ForAStraightLine_AndZero_ForANetZeroChop()
    {
        var line = new EfficiencyRatio(4);
        foreach (var close in new double[] { 1, 2, 3, 4 })
        {
            line.Update(close).Should().BeNull();
        }

        line.Update(5).Should().Be(1);

        var chop = new EfficiencyRatio(4);
        foreach (var close in new double[] { 1, 2, 1, 2 })
        {
            chop.Update(close);
        }

        chop.Update(1).Should().Be(0);
    }

    [Fact]
    public void EfficiencyRatio_ShouldReadZero_WhenTheMarketDidNotMove()
    {
        var flat = new EfficiencyRatio(2);
        flat.Update(5);
        flat.Update(5);

        flat.Update(5).Should().Be(0);
    }

    [Theory]
    [InlineData(30.0, 40.0, 10.0, 0.5, 110.0, 100.0, TrendRegime.TrendingUp)]
    [InlineData(30.0, 10.0, 40.0, 0.5, 90.0, 100.0, TrendRegime.TrendingDown)]
    [InlineData(30.0, 40.0, 10.0, 0.5, null, null, TrendRegime.TrendingUp)]
    [InlineData(30.0, 40.0, 10.0, 0.5, 90.0, 100.0, TrendRegime.Transition)]
    [InlineData(30.0, 40.0, 10.0, 0.1, 110.0, 100.0, TrendRegime.Transition)]
    [InlineData(15.0, 20.0, 18.0, 0.1, 110.0, 100.0, TrendRegime.Ranging)]
    [InlineData(22.0, 20.0, 18.0, 0.1, 110.0, 100.0, TrendRegime.Transition)]
    [InlineData(15.0, 20.0, 18.0, 0.25, 110.0, 100.0, TrendRegime.Transition)]
    public void Classify_ShouldApplyTheThresholds_WithATransitionBandBetween(
        double adx, double plusDi, double minusDi, double efficiency, double? emaFast, double? emaSlow, TrendRegime expected)
    {
        RegimeTracker.Classify(adx, plusDi, minusDi, efficiency, emaFast, emaSlow, RegimeOptions.Default).Should().Be(expected);
    }

    [Fact]
    public void Classify_ShouldBeUnknown_WhileTheInputsWarmUp()
    {
        RegimeTracker.Classify(null, null, null, 0.5, null, null, RegimeOptions.Default).Should().Be(TrendRegime.Unknown);
    }

    [Theory]
    [InlineData(30.0, 40.0, 10.0, 0.5, 110.0, 100.0, TrendRegime.TrendingUp, RegimeBasis.TrendMet)]
    [InlineData(30.0, 10.0, 40.0, 0.5, 90.0, 100.0, TrendRegime.TrendingDown, RegimeBasis.TrendMet)]
    [InlineData(30.0, 40.0, 10.0, 0.5, 90.0, 100.0, TrendRegime.Transition, RegimeBasis.DirectionDisagrees)]
    [InlineData(30.0, 40.0, 10.0, 0.1, 110.0, 100.0, TrendRegime.Transition, RegimeBasis.Between)]
    [InlineData(15.0, 20.0, 18.0, 0.1, 110.0, 100.0, TrendRegime.Ranging, RegimeBasis.RangeMet)]
    [InlineData(22.0, 20.0, 18.0, 0.1, 110.0, 100.0, TrendRegime.Transition, RegimeBasis.Between)]
    public void Explain_ShouldNameTheTestThatDecidedTheRegime(
        double adx, double plusDi, double minusDi, double efficiency, double? emaFast, double? emaSlow, TrendRegime expected, RegimeBasis basis)
    {
        var (trend, why) = RegimeTracker.Explain(adx, plusDi, minusDi, efficiency, emaFast, emaSlow, RegimeOptions.Default);

        trend.Should().Be(expected);
        why.Should().Be(basis);
    }

    [Fact]
    public void Explain_ShouldBeWarmup_WhileTheInputsWarmUp()
    {
        RegimeTracker.Explain(null, null, null, 0.5, null, null, RegimeOptions.Default).Should().Be((TrendRegime.Unknown, RegimeBasis.Warmup));
    }

    [Fact]
    public void State_ShouldCarryTheThresholdsItWasJudgedAgainst_AndTheBasis()
    {
        var options = RegimeOptions.Default with { TrendAdx = 27, TrendEfficiency = 0.35, RangeAdx = 18, RangeEfficiency = 0.15 };
        var tracker = new RegimeTracker(Bar, options);

        var warming = tracker.State();
        warming.Basis.Should().Be(RegimeBasis.Warmup);
        warming.Thresholds.Should().Be(new RegimeThresholdsDto(27, 0.35, 18, 0.15));
    }

    [Theory]
    [InlineData(1, TrendRegime.TrendingUp)]
    [InlineData(-1, TrendRegime.TrendingDown)]
    public void Tracker_ShouldCallATrend_OnASteadilyDriftingSeries(int direction, TrendRegime expected)
    {
        var tracker = new RegimeTracker(Bar, RegimeOptions.Default);
        var random = new Random(3);
        for (var i = 0; i < 80; i++)
        {
            var close = 10_000 + (direction * i * 6) + random.Next(-2, 3);
            PlayBar(tracker, i, close + 4, close - 4, close);
        }

        tracker.AdvanceTo(T0 + (81L * Bar * 1000));
        var state = tracker.State();
        state.Trend.Should().Be(expected);
        state.Basis.Should().Be(RegimeBasis.TrendMet);
        state.Ready.Should().BeTrue();
        state.Adx.Should().BeGreaterThan(25);
        state.EfficiencyRatio.Should().BeGreaterThan(0.3);
        state.SinceMs.Should().NotBeNull();
    }

    [Fact]
    public void Tracker_ShouldCallARange_OnASeriesThatGoesNowhere()
    {
        var tracker = new RegimeTracker(Bar, RegimeOptions.Default);
        var random = new Random(5);
        for (var i = 0; i < 80; i++)
        {
            var close = 10_000 + random.Next(-6, 7);
            PlayBar(tracker, i, close + 8, close - 8, close);
        }

        tracker.AdvanceTo(T0 + (81L * Bar * 1000));
        var state = tracker.State();
        state.Trend.Should().Be(TrendRegime.Ranging);
        state.Basis.Should().Be(RegimeBasis.RangeMet);
        state.Adx.Should().BeLessThan(20);
    }

    [Fact]
    public void Tracker_ShouldReportWarmingUp_AndSkipBarsWithoutTrades()
    {
        var tracker = new RegimeTracker(Bar, RegimeOptions.Default);
        PlayBar(tracker, 0, 101, 99, 100);
        tracker.AdvanceTo(T0 + (50L * Bar * 1000));

        var state = tracker.State();
        state.Trend.Should().Be(TrendRegime.Unknown);
        state.Ready.Should().BeFalse();
        state.SeenBars.Should().Be(1, "empty bars are not counted");
        state.WarmupBars.Should().Be(28);
    }

    // reference: REQUIREMENTS.md FR-75
    [Fact]
    public void RangeZones_ShouldFollowTheTrackersOwnClassification_WhenASeriesRanges()
    {
        var tracker = new RegimeTracker(Bar, RegimeOptions.Default);
        var random = new Random(5);
        for (var i = 0; i < 80; i++)
        {
            var close = 10_000 + random.Next(-6, 7);
            PlayBar(tracker, i, close + 8, close - 8, close);
        }

        tracker.AdvanceTo(T0 + (81L * Bar * 1000));

        tracker.Trend.Should().Be(TrendRegime.Ranging);
        var zones = tracker.RangeZones;
        zones.Should().NotBeEmpty();
        zones[^1].EndMs.Should().Be(T0 + (80L * Bar * 1000), "the live zone ends at the last closed bar");
        zones[0].StartMs.Should().BeGreaterThanOrEqualTo(T0 + ((RegimeOptions.Default.WarmupBars - 1L) * Bar * 1000), "warmup bars are Unknown");
        zones.Should().OnlyContain(z => z.LowTicks >= 10_000 - 14 && z.HighTicks <= 10_000 + 14 && z.LowTicks < z.HighTicks);
    }

    [Fact]
    public void RangeZones_ShouldGrowWithEachClosedBar_AndNeverHoldTheDevelopingBar()
    {
        var tracker = new RegimeTracker(Bar, RegimeOptions.Default);
        var random = new Random(5);
        for (var i = 0; i < 80; i++)
        {
            var close = 10_000 + random.Next(-6, 7);
            PlayBar(tracker, i, close + 8, close - 8, close);
        }

        // Bar 79 is still forming: its trades are in, but it has not closed
        tracker.Trend.Should().Be(TrendRegime.Ranging);
        tracker.RangeZones[^1].EndMs.Should().Be(T0 + (79L * Bar * 1000));
        var version = tracker.RangeZoneVersion;

        tracker.AdvanceTo(T0 + (80L * Bar * 1000));

        tracker.RangeZones[^1].EndMs.Should().Be(T0 + (80L * Bar * 1000));
        tracker.RangeZoneVersion.Should().BeGreaterThan(version);
    }

    [Fact]
    public void RangeZones_ShouldBeEmpty_WhileWarmingUpOrTrending()
    {
        var tracker = new RegimeTracker(Bar, RegimeOptions.Default);
        var random = new Random(3);
        for (var i = 0; i < 80; i++)
        {
            var close = 10_000 + (i * 6) + random.Next(-2, 3);
            PlayBar(tracker, i, close + 4, close - 4, close);
        }

        tracker.AdvanceTo(T0 + (81L * Bar * 1000));

        tracker.Trend.Should().Be(TrendRegime.TrendingUp);
        tracker.RangeZones.Should().BeEmpty();
    }

    [Fact]
    public void TrimRangeZones_ShouldDropZonesOlderThanTheCutoff()
    {
        var tracker = new RegimeTracker(Bar, RegimeOptions.Default);
        var random = new Random(5);
        for (var i = 0; i < 80; i++)
        {
            var close = 10_000 + random.Next(-6, 7);
            PlayBar(tracker, i, close + 8, close - 8, close);
        }

        tracker.AdvanceTo(T0 + (81L * Bar * 1000));
        tracker.TrimRangeZones(T0 + (81L * Bar * 1000));

        tracker.RangeZones.Should().BeEmpty();
    }

    private static void PlayBar(RegimeTracker tracker, int index, long high, long low, long close)
    {
        var start = T0 + (index * Bar * 1000L);
        tracker.AddTrade(start + 1_000, low, 1, buyerAggressor: false);
        tracker.AddTrade(start + 2_000, high, 1, buyerAggressor: true);
        tracker.AddTrade(start + 3_000, close, 1, buyerAggressor: true);
    }

    [Fact]
    public void WarmupHours_IsTheSlowestTimeframeTimesTheWarmupBars()
    {
        RegimeOptions.Default.WarmupBars.Should().Be(28);
        RegimeOptions.Default.WarmupHours.Should().Be(7);
        (RegimeOptions.Default with { TimeframesSeconds = [] }).WarmupHours.Should().Be(0);
    }
}
