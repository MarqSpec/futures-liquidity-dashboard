using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Engine;

// reference: REQUIREMENTS.md FR-2 acceptance: changing the visible history leaves profile totals and closed indicator values
// unchanged at matching timestamps; changing the indicator timeframe recomputes the indicators and nothing else.
// The display interval is a client re-aggregation and is pinned in the dashboard (DashboardRoute.viewSettings.test.tsx).
public sealed class InstrumentEngineViewSettingsTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Snapshot_ShouldKeepProfileTotalsVwapAndClosedIndicatorValues_WhenOnlyTheVisibleHistoryChanges()
    {
        var engine = EngineAfterNinetyMinutes();

        var shortHistory = engine.Snapshot(30, null);
        var longHistory = engine.Snapshot(240, null);

        longHistory.MinuteBars.Count.Should().BeGreaterThan(shortHistory.MinuteBars.Count, "the history setting must reach the chart data");
        longHistory.Profiles.Should().NotBeEmpty().And.BeEquivalentTo(shortHistory.Profiles);
        longHistory.Vwap.Should().BeEquivalentTo(shortHistory.Vwap);
        longHistory.Indicators.Should().NotBeEmpty().And.BeEquivalentTo(shortHistory.Indicators);
        longHistory.Indicators.SelectMany(series => series.Points).Should().NotBeEmpty("a closed value must exist to compare");
        longHistory.Liquidity.Should().BeEquivalentTo(shortHistory.Liquidity);
    }

    [Fact]
    public void ForIndicatorMinutes_ShouldChangeOnlyTheIndicatorSeries_WhenTheIndicatorTimeframeChanges()
    {
        var snapshot = EngineAfterNinetyMinutes().Snapshot(60, null);

        var fiveMinute = snapshot.ForIndicatorMinutes(5);

        fiveMinute.Indicators.Should().NotBeEmpty().And.OnlyContain(series => series.Tf == 300);
        fiveMinute.Indicators.Should().BeEquivalentTo(snapshot.Indicators.Where(series => series.Tf == 300));
        snapshot.Indicators.Where(series => series.Id == "ema10").Select(series => series.Points.Count).Distinct()
            .Should().HaveCount(3, "each timeframe is its own series, computed from its own bars");
        fiveMinute.Should().BeEquivalentTo(snapshot, options => options.Excluding(shown => shown.Indicators));
        snapshot.Indicators.Select(series => series.Tf).Distinct().Should().BeEquivalentTo([60, 300, 900]);
    }

    /// <summary>Ninety minutes of live prints, four a minute, drifting through a few prices: enough for closed EMAs and profiles.</summary>
    private static InstrumentEngine EngineAfterNinetyMinutes()
    {
        var engine = new InstrumentEngine(InstrumentCatalog.MES, null, TestData.Calendar());
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));
        for (var i = 1; i <= 90 * 4; i++)
        {
            var side = i % 3 == 0 ? BookSide.Ask : BookSide.Bid;
            engine.Apply(TestData.Trade(T0 + (i * 15_000L), TestData.EsBase + (i / 40 % 7) + (i % 3), 1 + (i % 4), side, $"v{i}"));
        }

        engine.Tick(T0 + (90 * 60_000L) + 1_000);
        return engine;
    }
}
