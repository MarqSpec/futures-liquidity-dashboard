using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-44–FR-47, ARCHITECTURE.md D-21
public sealed class BarFlowAnalyzerTests
{
    private const long BarMs = 60_000;
    private static readonly long T0 = TestData.EpochMs;
    private static readonly IReadOnlyList<KeyLevel> NoLevels = [];

    [Fact]
    public void OnBarClosed_ShouldReturnNoZScore_WhenFewerThanTheMinimumSamplesWereSeen()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var next = Baseline(analyzer, count: 7);

        var result = analyzer.OnBarClosed(TestData.Bar(next, 1000, 1000, 1000, 1000, 50), NoLevels);

        result.DeltaZ.Should().BeNull();
    }

    [Fact]
    public void OnBarClosed_ShouldReturnTheDeltaZScore_WhenTheMinimumSamplesWereSeen()
    {
        // Eight samples alternating ±2: mean 0, standard deviation 2, so a delta of +10 is 5σ.
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var next = Baseline(analyzer, count: 8);

        var result = analyzer.OnBarClosed(TestData.Bar(next, 1000, 1000, 1000, 1000, 10), NoLevels);

        result.DeltaZ.Should().BeApproximately(5.0, 1e-9);
    }

    [Fact]
    public void OnBarClosed_ShouldReportBuyingExhaustion_WhenASpikeNearAKeyLevelClosesInTheLowerPartOfItsRange()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var next = Baseline(analyzer);

        var result = analyzer.OnBarClosed(TestData.Bar(next, 1000, 1010, 1000, 1002, 10), [new KeyLevel("prior session high", 1012, IsHigh: true)]);

        var signal = result.Signals.Should().ContainSingle(s => s.Kind == SignalKind.DeltaExhaustion).Subject;
        signal.Bias.Should().Be(SignalBias.Bearish);
        (signal.Low, signal.High).Should().Be((1010L, 1010L));
        signal.Strength.Should().Be(1.0);
        signal.Label.Should().Be("Buying exhausted");
    }

    [Fact]
    public void OnBarClosed_ShouldReportBuyingExhaustion_WhenTheCloseIsExactlyAtTheExhaustionFraction()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var next = Baseline(analyzer);

        var result = analyzer.OnBarClosed(TestData.Bar(next, 1000, 1010, 1000, 1004, 10), [new KeyLevel("prior session high", 1012, IsHigh: true)]);

        result.Signals.Should().Contain(s => s.Kind == SignalKind.DeltaExhaustion);
    }

    [Fact]
    public void OnBarClosed_ShouldNotReportExhaustion_WhenTheSpikeBarClosesNearItsHigh()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var next = Baseline(analyzer);

        var result = analyzer.OnBarClosed(TestData.Bar(next, 1000, 1010, 1000, 1008, 10), [new KeyLevel("prior session high", 1012, IsHigh: true)]);

        result.Signals.Should().NotContain(s => s.Kind == SignalKind.DeltaExhaustion);
    }

    [Fact]
    public void OnBarClosed_ShouldNotReportExhaustion_WhenNoKeyLevelIsNearTheSpikeExtreme()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var next = Baseline(analyzer);

        var result = analyzer.OnBarClosed(TestData.Bar(next, 1000, 1010, 1000, 1002, 10), [new KeyLevel("prior session high", 1015, IsHigh: true)]);

        result.Signals.Should().BeEmpty();
    }

    [Fact]
    public void OnBarClosed_ShouldReportSellingExhaustion_WhenASellingSpikeNearAKeyLevelClosesInTheUpperPartOfItsRange()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var next = Baseline(analyzer);

        var result = analyzer.OnBarClosed(TestData.Bar(next, 1010, 1010, 1000, 1008, -10), [new KeyLevel("prior session low", 998, IsHigh: false)]);

        var signal = result.Signals.Should().ContainSingle(s => s.Kind == SignalKind.DeltaExhaustion).Subject;
        signal.Bias.Should().Be(SignalBias.Bullish);
        signal.Low.Should().Be(1000);
    }

    [Fact]
    public void OnBarClosed_ShouldReportTrappedBuyers_WhenABarClosesBelowTheSpikeBarsLowWithinTheReversalWindow()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var levels = new[] { new KeyLevel("prior session high", 1012, IsHigh: true) };
        var next = Baseline(analyzer);
        analyzer.OnBarClosed(TestData.Bar(next, 1000, 1010, 1000, 1008, 10), levels);

        var result = analyzer.OnBarClosed(TestData.Bar(next + BarMs, 1005, 1006, 998, 999, -2), levels);

        var signal = result.Signals.Should().ContainSingle(s => s.Kind == SignalKind.TrappedTraders).Subject;
        signal.Bias.Should().Be(SignalBias.Bearish);
        (signal.Low, signal.High).Should().Be((1000L, 1010L));
        signal.Label.Should().Be("Trapped buyers");
    }

    [Fact]
    public void OnBarClosed_ShouldReportTrappedBuyers_WhenTheReversalCloseComesOnTheLastBarOfTheWindow()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var levels = new[] { new KeyLevel("prior session high", 1012, IsHigh: true) };
        var next = Baseline(analyzer);
        analyzer.OnBarClosed(TestData.Bar(next, 1000, 1010, 1000, 1008, 10), levels);
        analyzer.OnBarClosed(TestData.Bar(next + BarMs, 1006, 1007, 1004, 1005, -2), levels);

        var result = analyzer.OnBarClosed(TestData.Bar(next + (2 * BarMs), 1005, 1006, 998, 999, -2), levels);

        result.Signals.Should().Contain(s => s.Kind == SignalKind.TrappedTraders);
    }

    [Fact]
    public void OnBarClosed_ShouldNotReportTrappedTraders_WhenTheReversalComesAfterTheWindow()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        var levels = new[] { new KeyLevel("prior session high", 1012, IsHigh: true) };
        var next = Baseline(analyzer);
        var results = new List<BarFlowResult>
        {
            analyzer.OnBarClosed(TestData.Bar(next, 1000, 1010, 1000, 1008, 10), levels),
            analyzer.OnBarClosed(TestData.Bar(next + BarMs, 1006, 1007, 1004, 1005, -2), levels),
            analyzer.OnBarClosed(TestData.Bar(next + (2 * BarMs), 1006, 1007, 1004, 1005, 2), levels),
        };

        results.Add(analyzer.OnBarClosed(TestData.Bar(next + (3 * BarMs), 1005, 1006, 998, 999, -2), levels));

        results.SelectMany(r => r.Signals).Should().NotContain(s => s.Kind == SignalKind.TrappedTraders);
    }

    [Fact]
    public void OnBarClosed_ShouldConfirmASwingHigh_WhenThreeBarsEachSideAreLower()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        long[] highs = [1000, 1001, 1002, 1005, 1002, 1001, 1000];

        var results = Feed(analyzer, highs, deltas: [.. highs.Select(_ => 0L)]);

        results[^1].NewPivots.Should().ContainSingle(p => p.IsHigh).Which.Should().Be(new SwingPivot(T0 + (3 * BarMs), 1005, IsHigh: true, 0, 3));
        results.Take(6).SelectMany(r => r.NewPivots).Should().BeEmpty();
    }

    [Fact]
    public void OnBarClosed_ShouldNotConfirmASwingHigh_WhenANeighbourEqualsThePivotHigh()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        long[] highs = [1000, 1001, 1005, 1005, 1002, 1001, 1000];

        var results = Feed(analyzer, highs, deltas: [.. highs.Select(_ => 0L)]);

        results.SelectMany(r => r.NewPivots).Should().NotContain(p => p.IsHigh);
    }

    [Fact]
    public void OnBarClosed_ShouldReportBearishCvdDivergence_WhenAHigherSwingHighHasALowerCvd()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);

        var results = Feed(analyzer, DivergenceHighs, DivergenceDeltas(firstLeg: 5, secondLeg: -5));

        var signal = results.SelectMany(r => r.Signals).Should().ContainSingle(s => s.Kind == SignalKind.CvdDivergence).Subject;
        signal.Bias.Should().Be(SignalBias.Bearish);
        signal.Low.Should().Be(1008);
        signal.Strength.Should().Be(1.0);
    }

    [Fact]
    public void OnBarClosed_ShouldNotReportDivergence_WhenCvdConfirmsTheHigherHigh()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);

        var results = Feed(analyzer, DivergenceHighs, DivergenceDeltas(firstLeg: 5, secondLeg: 5));

        results.SelectMany(r => r.Signals).Should().NotContain(s => s.Kind == SignalKind.CvdDivergence);
    }

    [Fact]
    public void OnBarClosed_ShouldNotReportDivergence_WhenThePivotsAreFurtherApartThanTheMaximum()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default with { DivergenceMaxBars = 5 });

        var results = Feed(analyzer, DivergenceHighs, DivergenceDeltas(firstLeg: 5, secondLeg: -5));

        results.SelectMany(r => r.Signals).Should().NotContain(s => s.Kind == SignalKind.CvdDivergence);
    }

    [Fact]
    public void OnBarClosed_ShouldReportBullishCvdDivergence_WhenALowerSwingLowHasAHigherCvd()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        long[] lows = [1000, 999, 998, 995, 998, 999, 1000, 999, 998, 997, 992, 997, 998, 999];

        // Feed takes highs; lows sit two ticks under each high.
        var results = Feed(analyzer, [.. lows.Select(l => l + 2)], DivergenceDeltas(firstLeg: -5, secondLeg: 5));

        var signal = results.SelectMany(r => r.Signals).Should().ContainSingle(s => s.Kind == SignalKind.CvdDivergence).Subject;
        signal.Bias.Should().Be(SignalBias.Bullish);
        signal.Low.Should().Be(992);
    }

    [Fact]
    public void Cvd_ShouldAccumulateClosedBarDeltas_WhenBarsClose()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        analyzer.OnBarClosed(TestData.Bar(T0, 1000, 1000, 1000, 1000, 7), NoLevels);
        analyzer.OnBarClosed(TestData.Bar(T0 + BarMs, 1000, 1000, 1000, 1000, -3), NoLevels);
        var developing = TestData.Bar(T0 + (2 * BarMs), 1000, 1000, 1000, 1000, 2);

        analyzer.Cvd.Should().Be(4);
        analyzer.LiveCvd(developing).Should().Be(6);
        analyzer.CvdSeries.Should().Equal((T0 + BarMs, 7L), (T0 + (2 * BarMs), 4L));
    }

    [Fact]
    public void ResetSession_ShouldClearCvdAndPivots_WhenANewSessionStarts()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);
        long[] highs = [1000, 1001, 1002, 1005, 1002, 1001, 1000];
        Feed(analyzer, highs, deltas: [.. highs.Select(_ => 3L)]);

        analyzer.ResetSession();

        analyzer.Cvd.Should().Be(0);
        analyzer.Pivots.Should().BeEmpty();
        analyzer.CvdSeries.Should().BeEmpty();
    }

    [Fact]
    public void OnBarClosed_ShouldIgnoreTheBar_WhenItIsEmpty()
    {
        var analyzer = new BarFlowAnalyzer(OrderFlowOptions.Default);

        var result = analyzer.OnBarClosed(new FootprintBar(T0, BarMs), NoLevels);

        result.DeltaZ.Should().BeNull();
        result.Signals.Should().BeEmpty();
        analyzer.CvdSeries.Should().BeEmpty();
    }

    private static readonly long[] DivergenceHighs = [1000, 1001, 1002, 1005, 1002, 1001, 1000, 1001, 1002, 1003, 1008, 1003, 1002, 1001];

    /// <summary>Four bars of <paramref name="firstLeg"/> then ten of <paramref name="secondLeg"/>: swing CVDs ±20 then ∓15.</summary>
    private static long[] DivergenceDeltas(long firstLeg, long secondLeg) =>
        [.. Enumerable.Repeat(firstLeg, 4), .. Enumerable.Repeat(secondLeg, 10)];

    /// <summary>Eight flat bars alternating delta +2/−2 (no pivots, mean 0, σ 2); returns the next bar's start.</summary>
    private static long Baseline(BarFlowAnalyzer analyzer, int count = 8)
    {
        for (var i = 0; i < count; i++)
        {
            analyzer.OnBarClosed(TestData.Bar(T0 + (i * BarMs), 1000, 1000, 1000, 1000, i % 2 == 0 ? 2 : -2), NoLevels);
        }

        return T0 + (count * BarMs);
    }

    /// <summary>One bar per high: low two ticks under, open and close one tick under.</summary>
    private static List<BarFlowResult> Feed(BarFlowAnalyzer analyzer, long[] highs, long[] deltas) =>
        [.. highs.Select((h, i) => analyzer.OnBarClosed(TestData.Bar(T0 + (i * BarMs), h - 1, h, h - 2, h - 1, deltas[i]), NoLevels))];
}
