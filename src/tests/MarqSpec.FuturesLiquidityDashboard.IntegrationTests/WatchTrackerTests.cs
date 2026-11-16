using MarqSpec.FuturesLiquidityDashboard.Api.Hubs;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using Microsoft.Extensions.Configuration;

namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

// reference: REQUIREMENTS.md FR-54 (depth for what viewers watch, reference counted)
[Trait("Deployment", "None")]
public sealed class WatchTrackerTests
{
    private static readonly InstrumentRoot Nq = InstrumentRoot.Parse("NQ");
    private static readonly InstrumentRoot Zn = InstrumentRoot.Parse("ZN");

    [Fact]
    public void Subscribe_HoldsDepthOnce_EvenWhenAResyncSubscribesAgain()
    {
        var (tracker, registry, depth) = Tracker();
        registry.TryGet(Nq, out var engine);

        tracker.Subscribe("a", engine, 5, null);
        tracker.Subscribe("a", engine, 5, null);

        depth.Viewers(Nq).Should().Be(1);
        engine.Watchers.Should().Be(1);
    }

    [Fact]
    public void Unsubscribe_ReleasesDepth_UnlessTheWatchlistStillHoldsIt()
    {
        var (tracker, registry, depth) = Tracker();
        registry.TryGet(Nq, out var nq);
        registry.TryGet(Zn, out var zn);
        tracker.Subscribe("a", nq, 5, null);
        tracker.Subscribe("a", zn, 5, null);
        tracker.SetWatchlist("a", [Zn], _ => true);

        tracker.Unsubscribe("a", Nq);
        tracker.Unsubscribe("a", Zn);

        depth.Viewers(Nq).Should().Be(0);
        depth.Viewers(Zn).Should().Be(1, "the watchlist still wants ZN's depth");
        nq.Watchers.Should().Be(0);
        zn.Watchers.Should().Be(0);
    }

    [Fact]
    public void SetWatchlist_RefusesUnknownForbiddenAndExtraRoots()
    {
        var (tracker, _, depth) = Tracker(maxWatchlist: 2);

        var result = tracker.SetWatchlist("a", [InstrumentRoot.ES, Nq, InstrumentRoot.Parse("ZZZ"), InstrumentRoot.GC, Zn], r => r != InstrumentRoot.GC);

        result.Depth.Should().Equal("ES", "NQ");
        result.Refused.Should().Equal("ZZZ", "GC", "ZN");
        depth.Viewers(Nq).Should().Be(1);
    }

    [Fact]
    public void Disconnect_LetsGoOfEverything_AndTwoViewersCountTwice()
    {
        var (tracker, registry, depth) = Tracker();
        registry.TryGet(Nq, out var nq);
        tracker.Subscribe("a", nq, 5, null);
        tracker.Subscribe("b", nq, 5, null);
        tracker.SetWatchlist("a", [Zn], _ => true);

        tracker.Disconnect("a");

        depth.Viewers(Nq).Should().Be(1);
        depth.Viewers(Zn).Should().Be(0);
        nq.Watchers.Should().Be(1);
        tracker.Connections.Should().Be(1);
    }

    private static (WatchTracker Tracker, EngineRegistry Registry, DepthDemand Depth) Tracker(int maxWatchlist = 12)
    {
        var registry = new EngineRegistry(
            [InstrumentRoot.ES, InstrumentRoot.GC, InstrumentRoot.CL, Nq, Zn],
            EngineOptions.Default,
            new ExchangeCalendar(TimeZoneInfo.Utc));
        var depth = new DepthDemand(new DepthOptions { Pinned = ["ES"] }, TimeProvider.System);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Api:MaxWatchlist"] = maxWatchlist.ToString(System.Globalization.CultureInfo.InvariantCulture) })
            .Build();
        return (new WatchTracker(registry, depth, configuration), registry, depth);
    }
}
