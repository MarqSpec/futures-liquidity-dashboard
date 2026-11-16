using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Indicators;

// reference: REQUIREMENTS.md FR-16 acceptance: each indicator's settings change only that indicator
public sealed class IndicatorEngineTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Series_ShouldChangeOnlyThatEma_WhenOneEmasPeriodAndTimeframeChange()
    {
        var settings = IndicatorSettings.Default with { Emas = [new(10), new(21, 300), new(24), new(48), new(200)] };

        var (before, after) = BothRuns(settings);

        after.Select(series => series.Id).Should().Equal("ema10", "ema21", "ema24", "ema48", "ema200", "rsi14", "macd", "atr14");
        after.Single(series => series.Id == "ema21").TimeframeSeconds.Should().Be(300);
        OthersShouldBeUnchanged(before, after, changedBefore: "ema13", changedAfter: "ema21");
    }

    [Fact]
    public void Series_ShouldChangeOnlyThatEma_WhenOnlyItsTimeframeChanges()
    {
        var settings = IndicatorSettings.Default with { Emas = [new(10), new(13), new(24, 900), new(48), new(200)] };

        var (before, after) = BothRuns(settings);

        after.Single(series => series.Id == "ema24").TimeframeSeconds.Should().Be(900);
        OthersShouldBeUnchanged(before, after, changedBefore: "ema24", changedAfter: "ema24");
    }

    [Fact]
    public void Series_ShouldChangeOnlyRsi_WhenItsPeriodAndTimeframeChange()
    {
        var (before, after) = BothRuns(IndicatorSettings.Default with { Rsi = new RsiSetting(7, 900) });

        after.Select(series => series.Id).Should().Contain("rsi7").And.NotContain("rsi14");
        after.Single(series => series.Id == "rsi7").TimeframeSeconds.Should().Be(900);
        OthersShouldBeUnchanged(before, after, changedBefore: "rsi14", changedAfter: "rsi7");
    }

    [Fact]
    public void Series_ShouldChangeOnlyMacd_WhenItsParametersAndTimeframeChange()
    {
        var (before, after) = BothRuns(IndicatorSettings.Default with { Macd = new MacdSetting(5, 35, 5, 300) });

        after.Single(series => series.Id == "macd").Label.Should().Be("MACD 5/35/5");
        OthersShouldBeUnchanged(before, after, changedBefore: "macd", changedAfter: "macd");
    }

    [Fact]
    public void Series_ShouldChangeOnlyAtr_WhenItsPeriodAndTimeframeChange()
    {
        var (before, after) = BothRuns(IndicatorSettings.Default with { Atr = new AtrSetting(20, 300) });

        after.Select(series => series.Id).Should().Contain("atr20").And.NotContain("atr14");
        OthersShouldBeUnchanged(before, after, changedBefore: "atr14", changedAfter: "atr20");
    }

    private static void OthersShouldBeUnchanged(
        IReadOnlyList<IndicatorSeries> before, IReadOnlyList<IndicatorSeries> after, string changedBefore, string changedAfter)
    {
        var untouched = before.Where(series => series.Id != changedBefore).ToList();
        untouched.Should().HaveCount(7);
        untouched.SelectMany(series => series.Points).Should().NotBeEmpty("closed values must exist to compare");
        foreach (var series in untouched)
        {
            after.Single(other => other.Id == series.Id).Should().BeEquivalentTo(series, $"changing {changedBefore} must not touch {series.Id}");
        }

        after.Where(series => series.Id != changedAfter).Should().HaveCount(7);
        before.Single(series => series.Id == changedBefore).Points.Should().NotBeEmpty();
    }

    /// <summary>The same fixture of prints, two a minute for 31 hours, through the default settings and through <paramref name="changed"/>.</summary>
    private static (IReadOnlyList<IndicatorSeries> Before, IReadOnlyList<IndicatorSeries> After) BothRuns(IndicatorSettings changed) =>
        (Run(IndicatorSettings.Default), Run(changed));

    private static IReadOnlyList<IndicatorSeries> Run(IndicatorSettings settings)
    {
        var engine = new IndicatorEngine(settings);
        const int prints = 250 * 15;
        for (var i = 0; i < prints; i++)
        {
            // A drifting, wobbling synthetic price, two prints a minute.
            var price = TestData.EsBase + (i / 7 % 40) + (i * 13 % 11) - 5;
            engine.AddTrade(T0 + (i * 30_000L), price, 1 + (i % 5), buyerAggressor: i % 3 != 0);
        }

        engine.AdvanceTo(T0 + (prints * 30_000L) + 900_000);
        return engine.Series(includeDeveloping: false);
    }
}
