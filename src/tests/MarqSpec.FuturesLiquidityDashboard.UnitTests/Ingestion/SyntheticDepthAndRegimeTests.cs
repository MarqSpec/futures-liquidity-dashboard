using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.Regime;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Synthetic;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: REQUIREMENTS.md FR-54 (depth only for watched products), FR-56 (regimes); ARCHITECTURE.md D-12
public sealed class SyntheticDepthAndRegimeTests
{
    private static readonly long T0 = new DateTimeOffset(2026, 11, 10, 15, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();

    [Fact]
    public void Stream_ShouldSendQuotesAndNoDepth_ForAnUnwatchedProduct_ThenABaselineOnceWatched()
    {
        // The same cursor StreamAsync steps on its timer. Stepping it here does not wait on the wall clock,
        // so a busy runner cannot cancel the assertion at 20 seconds.
        var demand = new DepthDemand(new DepthOptions { Pinned = ["ES"], ReleaseDelayMs = 0 }, TimeProvider.System);
        var feed = new SyntheticMarketFeed(new SyntheticFeedOptions { Seed = 5, StepMs = 10 }, new ExchangeCalendar(), TimeProvider.System, demand);
        var nq = InstrumentCatalog.For(InstrumentRoot.Parse("NQ"));
        var cursor = feed.OpenCursor([InstrumentCatalog.ES, nq]);
        var before = new List<MarketEvent>();
        var after = new List<MarketEvent>();
        var now = T0;
        var steps = 0;
        void Take(IReadOnlyList<MarketEvent> batch)
        {
            foreach (var e in batch)
            {
                var list = demand.Viewers(nq.Root) == 0 ? before : after;
                list.Add(e);
                if (before.Count(x => x.Root == nq.Root && x is QuoteEvent) >= 5 && demand.Viewers(nq.Root) == 0)
                {
                    demand.Acquire(nq.Root);
                }
            }
        }

        Take(cursor.Prime(now));
        while (steps < 8_000 && !(after.OfType<DepthSnapshotEvent>().Any(x => x.Root == nq.Root) && after.Count(x => x.Root == nq.Root && x is DepthUpdateEvent) > 3))
        {
            now += 10;
            Take(cursor.Step(now));
            steps++;
        }

        steps.Should().BeLessThan(8_000, "the unwatched quotes and the watched baseline arrive without waiting on a timer");

        var nqBefore = before.Where(x => x.Root == nq.Root).ToList();
        nqBefore.Should().NotContain(x => x is DepthSnapshotEvent || x is DepthUpdateEvent || x is BookResetEvent);
        nqBefore.OfType<FeedStatusEvent>().Should().NotBeEmpty().And.OnlyContain(s => !s.DepthSubscribed);
        nqBefore.OfType<QuoteEvent>().Should().OnlyContain(q => q.BidTicks < q.AskTicks);
        before.Where(x => x.Root == InstrumentRoot.ES).OfType<DepthSnapshotEvent>().Should().NotBeEmpty("ES is pinned");

        var nqAfter = after.Where(x => x.Root == nq.Root).ToList();
        nqAfter.OfType<FeedStatusEvent>().Should().Contain(s => s.DepthSubscribed && s.Connected);
        var status = nqAfter.FindIndex(x => x is FeedStatusEvent { DepthSubscribed: true });
        var snapshot = nqAfter.FindIndex(x => x is DepthSnapshotEvent);
        snapshot.Should().BeGreaterThan(status, "the baseline follows the depth-on status");
        nqAfter.Take(snapshot).Should().NotContain(x => x is DepthUpdateEvent, "no update arrives before its baseline");
    }

    [Fact]
    public void Engine_FedAQuoteOnlyStream_ShowsTheTopOfBook_AndIsHealthyNotRecovering()
    {
        var spec = InstrumentCatalog.For(InstrumentRoot.Parse("NQ"));
        var engine = new InstrumentEngine(spec, null, TestData.Calendar());
        var status = new FeedStatusEvent
        {
            Root = spec.Root,
            ContractId = spec.ContractId,
            SourceTimeMs = T0,
            ReceivedTimeMs = T0,
            Epoch = 1,
            Sequence = 1,
            Connected = true,
            Provenance = FeedProvenance.Simulated,
            DepthSubscribed = false,
        };
        engine.Apply(status);
        engine.Apply(new QuoteEvent { Root = spec.Root, ContractId = spec.ContractId, SourceTimeMs = T0 + 1, ReceivedTimeMs = T0 + 1, Epoch = 1, Sequence = 2, BidTicks = 100_000, AskTicks = 100_001 });
        engine.Apply(new QuoteEvent { Root = spec.Root, ContractId = spec.ContractId, SourceTimeMs = T0 + 2, ReceivedTimeMs = T0 + 2, Epoch = 1, Sequence = 3, BidTicks = 100_005, AskTicks = 100_004 });

        var summary = engine.Summary();
        summary.Bid.Should().Be(100_000, "a crossed quote is refused and the previous top kept");
        summary.Ask.Should().Be(100_001);
        engine.Status().DepthSubscribed.Should().BeFalse();
        engine.Status().Code.Should().NotBe("RECOVERING", "a product without depth is not a fault");
    }

    [Fact]
    public void Simulator_OverADay_ShowsBothTrendsAndRanges_OnFiveMinuteBars()
    {
        var spec = InstrumentCatalog.ES;
        var profile = SyntheticProfile.For(spec);
        var simulator = new SyntheticInstrumentSimulator(spec, profile, 20261108, 20, (double)spec.ToTicks(profile.StartPrice));
        var tracker = new RegimeTracker(300, RegimeOptions.Default);
        var seen = new HashSet<TrendRegime>();
        var phases = new HashSet<bool>();
        simulator.Start(T0);
        for (var t = T0 + 250; t <= T0 + (24 * 3_600_000L); t += 250)
        {
            foreach (var trade in simulator.Step(t).OfType<TradeEvent>())
            {
                tracker.AddTrade(trade.SourceTimeMs, trade.PriceTicks, trade.Quantity, trade.Aggressor == BookSide.Bid);
            }

            tracker.AdvanceTo(t);
            seen.Add(tracker.Trend);
            phases.Add(simulator.Trending);
        }

        phases.Should().BeEquivalentTo([true, false], "the simulator alternates trend and range phases");
        seen.Should().Contain(TrendRegime.Ranging);
        seen.Should().Contain(r => r == TrendRegime.TrendingUp || r == TrendRegime.TrendingDown);
    }
}
