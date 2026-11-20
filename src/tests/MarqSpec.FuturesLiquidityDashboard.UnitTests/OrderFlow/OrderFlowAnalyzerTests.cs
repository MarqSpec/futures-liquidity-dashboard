using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-41–FR-52 (the order-flow layer end to end)
public sealed class OrderFlowAnalyzerTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void OnLevelChange_ShouldLogAnOfferIceberg_WhenLiveBuyingKeepsGettingRefilledAtTheAsk()
    {
        var (analyzer, book) = Started();

        PlayIcebergAndImbalance(analyzer, book, live: true);

        var iceberg = analyzer.Signals.All.Should().ContainSingle(s => s.Kind == SignalKind.Iceberg).Subject;
        iceberg.Bias.Should().Be(SignalBias.Bearish);
        iceberg.PriceTicks.Should().Be(1000);
        iceberg.Label.Should().Be("Inferred offer iceberg");
        iceberg.Detail.Should().Contain("not exchange order ids");
        analyzer.Icebergs.Should().ContainSingle().Which.Side.Should().Be(BookSide.Ask);
    }

    [Fact]
    public void OnLevelChange_ShouldSendTheIcebergsHiddenLowerBound_WhenItLogsTheSignal()
    {
        var (analyzer, book) = Started();

        PlayIcebergAndImbalance(analyzer, book, live: true);
        analyzer.Advance(T0 + 60_000);

        var iceberg = analyzer.Signals.All.Should().ContainSingle(s => s.Kind == SignalKind.Iceberg).Subject;
        iceberg.HiddenEstimate.Should().NotBeNull().And.BeGreaterThan(0);
        iceberg.Detail.Should().Contain($"hidden ≥ {iceberg.HiddenEstimate}", "the field and the text carry the same lower bound");
        analyzer.Signals.All.Where(s => s.Kind != SignalKind.Iceberg).Should().OnlyContain(s => s.HiddenEstimate == null);
    }

    [Fact]
    public void Advance_ShouldLogAStackedBuyImbalance_WhenTheFootprintBarCloses()
    {
        var (analyzer, book) = Started();
        PlayIcebergAndImbalance(analyzer, book, live: true);

        analyzer.Advance(T0 + 60_000);

        var stacked = analyzer.Signals.All.Should().ContainSingle(s => s.Kind == SignalKind.StackedImbalance).Subject;
        stacked.Bias.Should().Be(SignalBias.Bullish);
        (stacked.PriceTicks, stacked.PriceHighTicks).Should().Be((1000L, 1003L));
        analyzer.Zones.Should().ContainSingle();
        analyzer.ClosedFootprints.Should().ContainSingle();
    }

    [Fact]
    public void OnTrade_ShouldNotRunIcebergs_WhenTradesAreHistory()
    {
        var (analyzer, book) = Started();

        PlayIcebergAndImbalance(analyzer, book, live: false);

        analyzer.Icebergs.Should().BeEmpty();
        analyzer.Signals.All.Should().NotContain(s => s.Kind == SignalKind.Iceberg);
    }

    [Fact]
    public void Advance_ShouldStillWarmTheBarDetectors_WhenTradesAreHistory()
    {
        var (analyzer, book) = Started();
        PlayIcebergAndImbalance(analyzer, book, live: false);

        analyzer.Advance(T0 + 60_000);

        analyzer.Signals.All.Should().Contain(s => s.Kind == SignalKind.StackedImbalance);
        analyzer.Cvd.Should().Be(analyzer.ClosedFootprints[0].Delta);
    }

    [Fact]
    public void OnTrade_ShouldNotRunIcebergs_WhenIcebergsAreSwitchedOff()
    {
        var analyzer = new OrderFlowAnalyzer(OrderFlowOptions.Default with { EnableIcebergs = false }, tpoRowTicks: 4);
        analyzer.StartSession(TestData.SessionOpenMs, partialSinceMs: null);

        PlayIcebergAndImbalance(analyzer, TestData.Book(bestAsk: 1000), live: true);

        analyzer.Icebergs.Should().BeEmpty();
    }

    [Fact]
    public void Invalidate_ShouldForgetIcebergs_WhenTheBookIsNoLongerKnown()
    {
        var (analyzer, book) = Started();
        PlayIcebergAndImbalance(analyzer, book, live: true);

        analyzer.Invalidate();

        analyzer.Icebergs.Should().BeEmpty();
    }

    [Fact]
    public void OnTrade_ShouldCountASweepBehindTheNewestSignal_WhenThePrintIsLate()
    {
        var (analyzer, _) = Started();
        analyzer.OnTrade(T0, 1000, 1, buyerAggressor: true, displayedResting: null, live: false);
        analyzer.OnTrade(T0 + 1_000, 1010, 1, buyerAggressor: true, displayedResting: null, live: false);
        analyzer.Advance(T0 + 60_000);
        analyzer.Signals.Add(SignalKind.Spoof, SignalBias.Bearish, T0 + 120_000, 1000, 1000, 0.5, "spoof", "synthetic");
        var dropped = analyzer.Signals.LateDropped;
        analyzer.StartSession(TestData.SessionOpenMs + (24 * 60 * 60_000), partialSinceMs: null);

        analyzer.OnTrade(T0 + 2_000, 1012, 3, buyerAggressor: true, displayedResting: null, live: true);
        analyzer.OnTrade(T0 + 3_000, 1008, 1, buyerAggressor: false, displayedResting: null, live: true);

        analyzer.Signals.LateDropped.Should().Be(dropped + 1);
        analyzer.Signals.All.Should().NotContain(signal => signal.Kind == SignalKind.LiquiditySweep);
        analyzer.Signals.Newest!.TimeMs.Should().Be(T0 + 120_000);
    }

    [Fact]
    public void StartSession_ShouldTurnTheLastSessionsExtremesIntoPriorSessionLevels_WhenANewSessionStarts()
    {
        var (analyzer, _) = Started();
        analyzer.OnTrade(T0, 1000, 1, true, null, live: false);
        analyzer.OnTrade(T0 + 1_000, 1010, 1, true, null, live: false);
        analyzer.OnTrade(T0 + 2_000, 1005, 1, true, null, live: false);
        analyzer.Advance(T0 + 60_000);

        var openMs = TestData.SessionOpenMs + (24 * 60 * 60_000);
        analyzer.StartSession(openMs, partialSinceMs: null);

        analyzer.KeyLevels().Should().Contain([
            new KeyLevel("prior session high", 1010, IsHigh: true, AsOfMs: openMs),
            new KeyLevel("prior session low", 1000, IsHigh: false, AsOfMs: openMs)]);
        analyzer.SweepLevels.Select(l => l.PriceTicks).Should().BeEquivalentTo([1010L, 1000L]);
    }

    [Fact]
    public void KeyLevels_ShouldIncludeTheEnginesLevels_WhenExternalLevelsAreSet()
    {
        var (analyzer, _) = Started();
        analyzer.ExternalLevels = () => [new KeyLevel("VWAP", 1002, IsHigh: false)];

        analyzer.KeyLevels().Should().ContainSingle().Which.Name.Should().Be("VWAP");
    }

    // reference: REQUIREMENTS.md FR-42 acceptance: a print through the zone retires it (below a demand zone, above a supply zone)
    [Theory]
    [InlineData(1004L, 1)]
    [InlineData(1003L, 1)]
    [InlineData(1000L, 1)]
    [InlineData(999L, 0)]
    public void OnTrade_ShouldRetireTheDemandZone_WhenAPrintTradesBelowIt(long printTicks, int zonesLeft)
    {
        var (analyzer, _) = Started();
        PlayClosedBar(analyzer, (1000, 2, 4), (1001, 2, 6), (1002, 2, 6), (1003, 1, 6));
        analyzer.Zones.Should().ContainSingle().Which.Should().Match<ImbalanceZone>(z => z.Bias == SignalBias.Bullish && z.LowTicks == 1000 && z.HighTicks == 1003);

        analyzer.OnTrade(T0 + 61_000, printTicks, 1, buyerAggressor: true, displayedResting: null, live: false);

        analyzer.Zones.Should().HaveCount(zonesLeft);
    }

    // reference: REQUIREMENTS.md FR-42 acceptance: a print through the zone retires it (below a demand zone, above a supply zone)
    [Theory]
    [InlineData(996L, 1)]
    [InlineData(1000L, 1)]
    [InlineData(1003L, 1)]
    [InlineData(1004L, 0)]
    public void OnTrade_ShouldRetireTheSupplyZone_WhenAPrintTradesAboveIt(long printTicks, int zonesLeft)
    {
        var (analyzer, _) = Started();
        PlayClosedBar(analyzer, (1000, 6, 1), (1001, 6, 2), (1002, 6, 2), (1003, 4, 2));
        analyzer.Zones.Should().ContainSingle().Which.Should().Match<ImbalanceZone>(z => z.Bias == SignalBias.Bearish && z.LowTicks == 1000 && z.HighTicks == 1003);

        analyzer.OnTrade(T0 + 61_000, printTicks, 1, buyerAggressor: false, displayedResting: null, live: false);

        analyzer.Zones.Should().HaveCount(zonesLeft);
    }

    // reference: REQUIREMENTS.md FR-43 acceptance: a print above an unfinished high (below an unfinished low) clears the mark
    [Theory]
    [InlineData(1004L, new[] { 1000L })]
    [InlineData(1003L, new[] { 1000L, 1003L })]
    [InlineData(1000L, new[] { 1000L, 1003L })]
    [InlineData(999L, new[] { 1003L })]
    public void OnTrade_ShouldClearTheUnfinishedAuctionPriceTradedBeyond_WhenALaterPrintGoesPastIt(long printTicks, long[] remainingTicks)
    {
        var (analyzer, _) = Started();
        PlayClosedBar(analyzer, (1000, 2, 4), (1001, 2, 6), (1002, 2, 6), (1003, 1, 6));
        analyzer.UnfinishedAuctions.Select(u => (u.PriceTicks, u.AtHigh)).Should().BeEquivalentTo([(1003L, true), (1000L, false)]);

        analyzer.OnTrade(T0 + 61_000, printTicks, 1, buyerAggressor: true, displayedResting: null, live: false);

        analyzer.UnfinishedAuctions.Select(u => u.PriceTicks).Should().BeEquivalentTo(remainingTicks);
    }

    /// <summary>Plays one whole footprint bar from (price, sell quantity, buy quantity) cells and closes it.</summary>
    private static void PlayClosedBar(OrderFlowAnalyzer analyzer, params (long Price, long Sell, long Buy)[] cells)
    {
        var t = T0;
        foreach (var (price, sell, buy) in cells)
        {
            analyzer.OnTrade(t++, price, sell, buyerAggressor: false, displayedResting: null, live: false);
            analyzer.OnTrade(t++, price, buy, buyerAggressor: true, displayedResting: null, live: false);
        }

        analyzer.Advance(T0 + 60_000);
    }

    private static (OrderFlowAnalyzer Analyzer, OrderBook Book) Started()
    {
        var analyzer = new OrderFlowAnalyzer(OrderFlowOptions.Default, tpoRowTicks: 4);
        analyzer.StartSession(TestData.SessionOpenMs, partialSinceMs: null);
        return (analyzer, TestData.Book(bestAsk: 1000));
    }

    /// <summary>
    /// Inside one footprint bar: two buys of 8 lift a 10-lot offer at 1000 that refills each time (an iceberg), then
    /// buying of 6 at 1001–1003 against selling of 2 a tick lower (a 3× diagonal stack from 1000 to 1003).
    /// </summary>
    private static void PlayIcebergAndImbalance(OrderFlowAnalyzer analyzer, OrderBook book, bool live)
    {
        foreach (var start in new[] { T0, T0 + 400 })
        {
            analyzer.OnTrade(start, 1000, 8, buyerAggressor: true, displayedResting: 10, live);
            analyzer.OnLevelChange(start + 50, book.Apply(BookSide.Ask, 1000, 2)!.Value, book);
            analyzer.OnLevelChange(start + 200, book.Apply(BookSide.Ask, 1000, 10)!.Value, book);
        }

        var t = T0 + 1_000;
        foreach (var (price, bid, ask) in new (long, long, long)[] { (1000, 2, 0), (1001, 2, 6), (1002, 2, 6), (1003, 1, 6) })
        {
            analyzer.OnTrade(t++, price, bid, buyerAggressor: false, displayedResting: null, live);
            if (ask > 0)
            {
                analyzer.OnTrade(t++, price, ask, buyerAggressor: true, displayedResting: null, live);
            }
        }
    }
}
