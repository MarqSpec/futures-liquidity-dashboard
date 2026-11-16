using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Synthetic;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: ARCHITECTURE.md D-12 (synthetic feed), D-25 (synthetic order-flow scenarios); REQUIREMENTS.md FR-4
public sealed class SyntheticMarketTests
{
    // Tuesday 2026-11-10 09:00 CT, inside regular trading hours.
    private static readonly long T0 = new DateTimeOffset(2026, 11, 10, 15, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();

    [Fact]
    public void Simulator_SameSeed_ProducesTheSameMarket()
    {
        Run(InstrumentRoot.MES, seed: 7, minutes: 2).Should().Equal(Run(InstrumentRoot.MES, seed: 7, minutes: 2));
    }

    [Fact]
    public void Simulator_EveryEvent_IsOnTheTickGridAndSimulated()
    {
        var spec = InstrumentCatalog.MGC;
        var simulator = Create(spec, 11);
        var events = new List<MarketEvent>(simulator.Start(T0));
        for (var t = T0 + 50; t < T0 + 120_000; t += 50)
        {
            events.AddRange(simulator.Step(t));
        }

        events.OfType<FeedStatusEvent>().Should().OnlyContain(s => s.Provenance == FeedProvenance.Simulated);
        events.OfType<DepthSnapshotEvent>().Should().NotBeEmpty();
        events.OfType<TradeEvent>().Should().NotBeEmpty().And.OnlyContain(t => t.Quantity > 0 && t.Root == InstrumentRoot.MGC);
        var book = events.OfType<DepthSnapshotEvent>().First();
        book.Bids[0].PriceTicks.Should().BeLessThan(book.Asks[0].PriceTicks, "the book is never crossed");
    }

    [Theory]
    [InlineData("ES")]
    [InlineData("MES")]
    [InlineData("GC")]
    [InlineData("MGC")]
    [InlineData("CL")]
    [InlineData("MCL")]
    public void Simulator_OverHours_KeepsTheSpreadTight(string rootName)
    {
        var root = InstrumentRoot.Parse(rootName);
        var simulator = Create(InstrumentCatalog.For(root), 3);
        simulator.Start(T0);
        var widest = 0L;
        for (var t = T0 + 250; t <= T0 + (3 * 3_600_000); t += 250)
        {
            simulator.Step(t);
            widest = Math.Max(widest, simulator.BestAsk - simulator.BestBid);
        }

        widest.Should().BeLessThanOrEqualTo(2, "a liquid future trades one or two ticks wide, never hundreds");
    }

    [Fact]
    public void Simulator_FedIntoAnEngine_StagesTheOrderFlowScenarios()
    {
        var spec = InstrumentCatalog.MES;
        var engine = new InstrumentEngine(spec, EngineOptions.Default, new ExchangeCalendar());
        var simulator = Create(spec, 20261108);
        foreach (var e in simulator.Start(T0))
        {
            engine.Apply(e);
        }

        for (var t = T0 + 50; t <= T0 + (45 * 60_000); t += 50)
        {
            foreach (var e in simulator.Step(t))
            {
                engine.Apply(e);
            }

            if (t % 1000 == 0)
            {
                engine.Tick(t);
            }
        }

        var kinds = engine.Context().RecentSignals.Select(s => s.Kind).ToHashSet();
        var all = engine.Snapshot(60, null).OrderFlow.Signals.Select(s => s.Kind).ToHashSet();
        all.Should().Contain(SignalKind.Iceberg, "the simulator hides icebergs behind refilling clips (REQUIREMENTS.md FR-52)");
        all.Should().Contain(SignalKind.StackedImbalance);
        all.Count.Should().BeGreaterThanOrEqualTo(4, $"several scenario kinds appear in 45 minutes; saw {string.Join(", ", all)} (recent {kinds.Count})");
    }

    [Fact]
    public async Task Feed_History_IsWarmupTrades_AndTheLiveStreamContinuesFromIt()
    {
        var time = new FixedTime(DateTimeOffset.FromUnixTimeMilliseconds(T0));
        var feed = new SyntheticMarketFeed(new SyntheticFeedOptions { Seed = 3 }, new ExchangeCalendar(), time);

        var trades = await feed.GetTradesAsync(InstrumentCatalog.MCL, T0 - 600_000, T0, CancellationToken.None);

        trades.Should().NotBeEmpty();
        trades.Should().OnlyContain(t => t.SourceTimeMs <= T0 && t.SourceTimeMs > T0 - 600_000);
        trades.Select(t => t.TradeId).Should().OnlyHaveUniqueItems();
        trades.Select(t => t.SourceTimeMs).Should().BeInAscendingOrder();
    }

    [Fact]
    public void TimeOfDay_IsBusiestAtTheOpenAndQuietOvernight()
    {
        var feed = new SyntheticMarketFeed(new SyntheticFeedOptions(), new ExchangeCalendar(), TimeProvider.System);
        var open = new DateTimeOffset(2026, 11, 10, 14, 35, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(); // 08:35 CT
        var midday = new DateTimeOffset(2026, 11, 10, 18, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(); // 12:00 CT
        var night = new DateTimeOffset(2026, 11, 11, 4, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(); // 22:00 CT

        feed.TimeOfDay(open).Should().BeGreaterThan(feed.TimeOfDay(midday));
        feed.TimeOfDay(midday).Should().BeGreaterThan(feed.TimeOfDay(night));
    }

    private static List<string> Run(InstrumentRoot root, int seed, int minutes)
    {
        var simulator = Create(InstrumentCatalog.For(root), seed);
        var events = new List<MarketEvent>(simulator.Start(T0));
        for (var t = T0 + 50; t <= T0 + (minutes * 60_000L); t += 50)
        {
            events.AddRange(simulator.Step(t));
        }

        return events.Select(e => e.ToString()).ToList();
    }

    private static SyntheticInstrumentSimulator Create(InstrumentSpec spec, int seed)
    {
        var profile = SyntheticProfile.For(spec);
        return new SyntheticInstrumentSimulator(spec, profile, seed, 20, (double)spec.ToTicks(profile.StartPrice));
    }

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
