using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Engine;

// reference: REQUIREMENTS.md FR-75, FR-56, FR-2 (INTERFACES.md D.2)
public sealed class InstrumentEngineRangeZoneTests
{
    private const int FiveMinutes = 300_000;
    private static readonly long T0 = TestData.EpochMs - (TestData.EpochMs % (15 * 60_000L));

    [Fact]
    public void Snapshot_ShouldCarryOneEmptySetPerRegimeTimeframe_WhenNothingHasRanged()
    {
        var snapshot = NewEngine().Snapshot(240, null);

        snapshot.RangeZones.Select(set => set.TimeframeSeconds).Should().Equal(300, 900);
        snapshot.RangeZones.Should().OnlyContain(set => set.Zones.Count == 0);
    }

    [Fact]
    public void Snapshot_ShouldCarryTheRangeZones_WhenTheRegimeClassifiedTheProductRanging()
    {
        var engine = NewEngine();
        PlayRange(engine, bars: 80);

        var fiveMinute = engine.Snapshot(240, null).RangeZones.Single(set => set.TimeframeSeconds == 300);

        fiveMinute.Zones.Should().NotBeEmpty();
        fiveMinute.Zones[^1].EndMs.Should().Be(T0 + (80L * FiveMinutes), "the live zone ends at the last closed bar");
        engine.PlanMarket(null).Regimes.Single(r => r.TimeframeSeconds == 300).Trend.Should().Be(Core.Regime.TrendRegime.Ranging);
    }

    [Fact]
    public void Publish_ShouldCarryTheRangeZones_OnlyWhenTheyChanged()
    {
        var engine = NewEngine();
        PlayRange(engine, bars: 80, closeLast: false);

        var changed = engine.Publish(null);
        var unchanged = engine.Publish(null);
        engine.Tick(T0 + (80L * FiveMinutes));
        var grown = engine.Publish(null);

        changed.RangeZones.Should().NotBeNull();
        unchanged.RangeZones.Should().BeNull("nothing closed since the last publication");
        grown.RangeZones!.Single(set => set.TimeframeSeconds == 300).Zones[^1].EndMs.Should().Be(T0 + (80L * FiveMinutes));
    }

    [Fact]
    public void PublishIfWatched_ShouldNotResendUnchangedZones_WhenNobodyWatchedTheChange()
    {
        var engine = NewEngine();
        PlayRange(engine, bars: 80);

        engine.PublishIfWatched(null).Should().BeNull();
        engine.Watch(240, null);

        engine.Publish(null).RangeZones.Should().BeNull("the watcher's snapshot already holds them");
    }

    [Fact]
    public void Tick_ShouldDropAZone_WhenItEndedBeforeTheRetainedMinuteBars()
    {
        var engine = NewEngine(historyRetentionMinutes: 120);
        PlayRange(engine, bars: 80);
        engine.Snapshot(240, null).RangeZones.Single(set => set.TimeframeSeconds == 300).Zones.Should().NotBeEmpty();

        engine.Tick(T0 + (80L * FiveMinutes) + (121L * 60_000));

        engine.Snapshot(240, null).RangeZones.Should().OnlyContain(set => set.Zones.Count == 0);
    }

    private static InstrumentEngine NewEngine(int historyRetentionMinutes = 4320) => new(
        InstrumentCatalog.MES,
        EngineOptions.Default with { HistoryRetentionMinutes = historyRetentionMinutes },
        TestData.Calendar());

    /// <summary>Five-minute bars that go nowhere: the series RegimeTests calls a range. With <paramref name="closeLast"/> false the last bar is left forming.</summary>
    private static void PlayRange(InstrumentEngine engine, int bars, bool closeLast = true)
    {
        var random = new Random(5);
        for (var i = 0; i < bars; i++)
        {
            var start = T0 + (i * (long)FiveMinutes);
            var close = TestData.EsBase + random.Next(-6, 7);
            engine.Apply(TestData.Trade(start + 1_000, close - 8, 1, BookSide.Ask, $"l{i}"));
            engine.Apply(TestData.Trade(start + 2_000, close + 8, 1, BookSide.Bid, $"h{i}"));
            engine.Apply(TestData.Trade(start + 3_000, close, 1, BookSide.Bid, $"c{i}"));
        }

        if (closeLast)
        {
            engine.Tick(T0 + (bars * (long)FiveMinutes));
        }
    }
}
