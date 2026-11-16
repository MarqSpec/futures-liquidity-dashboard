using MarqSpec.Client.ProjectX;
using MarqSpec.Client.ProjectX.Api.Models;
using MarqSpec.Client.ProjectX.WebSocket;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: REQUIREMENTS.md FR-54 (every product, depth only for the watched ones)
public sealed class ProjectXDiscoveryTests
{
    private static readonly Contract[] Listed =
    [
        new() { Id = "CON.F.US.EP.Z26", Name = "ESZ6", TickSize = 0.25m, TickValue = 12.5m, ActiveContract = true },
        new() { Id = "CON.F.US.MES.Z26", Name = "MESZ6", TickSize = 0.25m, TickValue = 1.25m, ActiveContract = true },
        new() { Id = "CON.F.US.GCE.G27", Name = "GCG7", TickSize = 0.1m, TickValue = 10m, ActiveContract = true },
        new() { Id = "CON.F.US.CLE.F27", Name = "CLF7", TickSize = 0.01m, TickValue = 10m, ActiveContract = true },
        new() { Id = "CON.F.US.XYZ.H27", Name = "XYZH7", Description = "A product the catalog does not list", TickSize = 0.5m, TickValue = 5m, ActiveContract = true },
        new() { Id = "CON.F.US.BAD", Name = "not a contract", TickSize = 1m, ActiveContract = true },
    ];

    [Theory]
    [InlineData("ESZ6", "ES")]
    [InlineData("ESZ26", "ES")]
    [InlineData("MESZ6", "MES")]
    [InlineData("M6EZ25", "M6E")]
    [InlineData("6EH7", "6E")]
    public void RootOf_TakesTheRootBeforeTheMonthCode(string name, string root) =>
        ProjectXMarketFeed.RootOf(name).Should().Be(InstrumentRoot.Parse(root));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("ES")]
    [InlineData("esz6")]
    [InlineData("ESA6")]
    public void RootOf_IsNull_ForAnythingElse(string? name) => ProjectXMarketFeed.RootOf(name).Should().BeNull();

    [Theory]
    [InlineData("ESZ6", 2026, 12)]
    [InlineData("ESH7", 2027, 3)]
    [InlineData("ESZ26", 2026, 12)]
    [InlineData("CLF27", 2027, 1)]
    public void ContractMonth_IsTheNearestSuchMonth(string name, int year, int month) =>
        ProjectXMarketFeed.ContractMonth(name, new DateTimeOffset(2026, 11, 8, 0, 0, 0, TimeSpan.Zero))
            .Should().Be(new DateOnly(year, month, 1));

    [Fact]
    public async Task ResolveAsync_ForEveryProduct_KeepsOneContractPerRoot_FromTheGatewayList()
    {
        var (feed, _, _) = Feed(new ProjectXFeedOptions());

        var specs = await feed.ResolveAsync(InstrumentSelection.Everything, [], CancellationToken.None);

        specs.Select(s => s.Root.ToString()).Should().BeEquivalentTo(["ES", "MES", "GC", "CL", "XYZ"]);
        var es = specs.Single(s => s.Root == InstrumentRoot.ES);
        es.ContractId.Should().Be("ESZ6");
        es.Expiry.Should().Be(new DateOnly(2026, 12, 1));
        es.Sector.Should().Be(InstrumentCatalog.ES.Sector);
        var other = specs.Single(s => s.Root.ToString() == "XYZ");
        other.Sector.Should().Be(InstrumentCatalog.OtherSector);
        other.Name.Should().Be("A product the catalog does not list");
        other.TickSize.Should().Be(0.5m);
    }

    [Fact]
    public async Task ResolveAsync_ForEveryProduct_KeepsAProseName_WhenTheSymbolIdIsTheGatewayProduct()
    {
        var rows = Listed.Append(new Contract
        {
            Id = "CON.F.US.MGC.G27",
            Name = "Micro Gold",
            SymbolId = "F.US.MGC",
            TickSize = 0.1m,
            TickValue = 1m,
            ActiveContract = false,
        }).Append(new Contract
        {
            Id = "CON.F.US.MGC.J27",
            Name = "Micro Gold front",
            SymbolId = "F.US.MGC",
            TickSize = 0.1m,
            TickValue = 1m,
            ActiveContract = true,
        }).ToList();
        var (feed, _, _) = Feed(new ProjectXFeedOptions(), listed: rows);

        var specs = await feed.ResolveAsync(InstrumentSelection.Everything, [], CancellationToken.None);

        var gold = specs.Should().ContainSingle(s => s.Root == InstrumentRoot.MGC).Subject;
        gold.ContractId.Should().Be("Micro Gold front");
        specs.Should().NotContain(s => s.Root == InstrumentRoot.Parse("BAD"));
        specs.Should().ContainSingle(s => s.Root == InstrumentRoot.ES);
        specs.Should().ContainSingle(s => s.Root == InstrumentRoot.MES);
    }

    [Theory]
    [InlineData("F.US.MGC", "MGC")]
    [InlineData("F.US.MES.Z26", "MES")]
    [InlineData("f.us.mcl", "MCL")]
    public void RootOfSymbol_ShouldReadTheProductSegment_WhenTheIdIsTheGatewayForm(string symbolId, string root) =>
        ProjectXMarketFeed.RootOfSymbol(symbolId).Should().Be(InstrumentRoot.Parse(root));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("MES")]
    [InlineData("F.US.")]
    public void RootOfSymbol_ShouldBeNull_WhenTheIdIsNotAGatewayProduct(string? symbolId) =>
        ProjectXMarketFeed.RootOfSymbol(symbolId).Should().BeNull();

    [Fact]
    public async Task ResolveAsync_LeavesOutTheExcluded_AndCapsAtMaxContracts_InPickerOrder()
    {
        var (feed, _, _) = Feed(new ProjectXFeedOptions { MaxContracts = 2 });
        var selection = InstrumentSelection.Everything with { Excluded = new HashSet<InstrumentRoot> { InstrumentRoot.Parse("MES") } };

        var specs = await feed.ResolveAsync(selection, [], CancellationToken.None);

        specs.Should().HaveCount(2);
        specs.Select(s => s.Root).Should().NotContain(InstrumentRoot.Parse("MES"));
        specs.Select(s => s.Root).Should().Equal(specs.OrderBy(s => InstrumentCatalog.SectorOrder(s.Sector)).ThenBy(s => InstrumentCatalog.Order(s.Root)).Select(s => s.Root));
    }

    [Fact]
    public async Task StreamAsync_SubscribesTradesAndQuotesForAll_ButDepthOnlyForTheWanted_AndFollowsViewers()
    {
        var time = new ManualTime(new DateTimeOffset(2026, 11, 9, 15, 0, 0, TimeSpan.Zero));
        var depth = new DepthDemand(new DepthOptions { Pinned = ["ES"], ReleaseDelayMs = 0 }, time);
        var (feed, socket, _) = Feed(new ProjectXFeedOptions(), depth, time);
        var specs = await feed.ResolveAsync(InstrumentSelection.Of(InstrumentRoot.ES, InstrumentRoot.GC), [], CancellationToken.None);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var run = feed.StreamAsync(specs, cts.Token).GetAsyncEnumerator(cts.Token);
        var first = new List<MarketEvent>();
        while (first.Count < 3 && await run.MoveNextAsync())
        {
            first.Add(run.Current);
        }

        A.CallTo(() => socket.SubscribeToTradeUpdatesAsync("CON.F.US.EP.Z26", A<CancellationToken>._)).MustHaveHappenedOnceExactly();
        A.CallTo(() => socket.SubscribeToTradeUpdatesAsync("CON.F.US.GCE.G27", A<CancellationToken>._)).MustHaveHappenedOnceExactly();
        A.CallTo(() => socket.SubscribeToPriceUpdatesAsync("CON.F.US.GCE.G27", A<CancellationToken>._)).MustHaveHappenedOnceExactly();
        A.CallTo(() => socket.SubscribeToOrderBookUpdatesAsync("CON.F.US.EP.Z26", A<CancellationToken>._)).MustHaveHappenedOnceExactly();
        A.CallTo(() => socket.SubscribeToOrderBookUpdatesAsync("CON.F.US.GCE.G27", A<CancellationToken>._)).MustNotHaveHappened();
        first.OfType<FeedStatusEvent>().Should().Contain(s => s.Root == InstrumentRoot.GC && !s.DepthSubscribed);
        first.OfType<BookResetEvent>().Should().ContainSingle().Which.Root.Should().Be(InstrumentRoot.ES);

        // A viewer opens GC: depth is subscribed and its book starts building.
        depth.Acquire(InstrumentRoot.GC);
        socket.TradeUpdateReceived += Raise.With(socket, new TradeUpdate { ContractId = "CON.F.US.GCE.G27", Price = 4000m, Volume = 1, Type = TradeLogType.Buy, Timestamp = DateTime.UtcNow });
        var reset = await NextAsync<BookResetEvent>(run);
        reset.Root.Should().Be(InstrumentRoot.GC);
        A.CallTo(() => socket.SubscribeToOrderBookUpdatesAsync("CON.F.US.GCE.G27", A<CancellationToken>._)).MustHaveHappenedOnceExactly();

        // The viewer leaves (no release delay): depth is unsubscribed and the status says so.
        depth.Release(InstrumentRoot.GC);
        socket.TradeUpdateReceived += Raise.With(socket, new TradeUpdate { ContractId = "CON.F.US.GCE.G27", Price = 4000.1m, Volume = 1, Type = TradeLogType.Sell, Timestamp = DateTime.UtcNow });
        var off = await NextAsync<FeedStatusEvent>(run, s => s.Root == InstrumentRoot.GC && !s.DepthSubscribed);
        off.Connected.Should().BeTrue();
        A.CallTo(() => socket.UnsubscribeFromOrderBookUpdatesAsync("CON.F.US.GCE.G27", A<CancellationToken>._)).MustHaveHappenedOnceExactly();
        await cts.CancelAsync();
    }

    [Fact]
    public void ContractState_WithoutDepth_ConnectsWithoutAReset_IgnoresRows_AndMapsQuotes()
    {
        var state = new ProjectXMarketFeed.ContractState(InstrumentCatalog.ES with { ContractId = "ESZ6" }) { DepthSubscribed = false };

        state.Connected(1_000, 1_500).Should().ContainSingle().Which.Should().BeOfType<FeedStatusEvent>()
            .Which.DepthSubscribed.Should().BeFalse();
        state.OnDepth(new OrderBookUpdate { Type = DomType.Bid, Price = 6800m, Volume = 5 }, 1_100, 1_500).Should().BeEmpty();
        state.Building.Should().BeFalse();

        var quote = state.OnQuote(new PriceUpdate { BestBid = 6800m, BestAsk = 6800.25m, Timestamp = DateTime.UtcNow }, 1_200)!;
        quote.BidTicks.Should().Be(27200);
        quote.AskTicks.Should().Be(27201);
        state.OnQuote(new PriceUpdate { BestBid = 6800m, BestAsk = 6800.25m, Timestamp = DateTime.UtcNow }, 1_300).Should().BeNull("the top did not change");
        state.OnQuote(new PriceUpdate { BestBid = 6800.1m, BestAsk = 0m, Timestamp = DateTime.UtcNow }, 1_400).Should().BeNull("off the tick grid");
    }

    [Fact]
    public void ContractState_DepthOff_ThenOn_RebuildsTheBook_InTheSameEpoch()
    {
        var state = new ProjectXMarketFeed.ContractState(InstrumentCatalog.ES with { ContractId = "ESZ6" });
        var connected = state.Connected(0, 100);
        state.TrySettle(200, 10).Should().NotBeNull();

        state.DepthOff(300).Should().ContainSingle().Which.Should().BeOfType<FeedStatusEvent>().Which.DepthSubscribed.Should().BeFalse();
        var on = state.DepthOn(400, 100);

        on.Should().HaveCount(2);
        on[1].Should().BeOfType<BookResetEvent>();
        on.Should().OnlyContain(e => e.Epoch == connected[0].Epoch);
        state.Building.Should().BeTrue();
    }

    private static async Task<T> NextAsync<T>(IAsyncEnumerator<MarketEvent> run, Func<T, bool>? match = null)
        where T : MarketEvent
    {
        while (await run.MoveNextAsync())
        {
            if (run.Current is T e && (match is null || match(e)))
            {
                return e;
            }
        }

        throw new InvalidOperationException($"the stream ended without a {typeof(T).Name}");
    }

    private static (ProjectXMarketFeed Feed, IProjectXWebSocketClient Socket, IProjectXApiClient Api) Feed(
        ProjectXFeedOptions options,
        DepthDemand? depth = null,
        TimeProvider? time = null,
        IReadOnlyList<Contract>? listed = null)
    {
        var rows = listed ?? Listed;
        var api = A.Fake<IProjectXApiClient>();
        A.CallTo(() => api.GetAvailableContractsAsync(A<bool>._, A<CancellationToken>._)).Returns(rows.ToList());
        A.CallTo(() => api.SearchContractsAsync(A<string>._, A<bool>._, A<CancellationToken>._))
            .ReturnsLazily((string text, bool _, CancellationToken _) => rows.Where(c => c.Name is not null && c.Name.StartsWith(text, StringComparison.Ordinal)).ToList());
        var socket = A.Fake<IProjectXWebSocketClient>();
        var scopes = new ServiceCollection().AddSingleton(api).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        var feed = new ProjectXMarketFeed(options, scopes, socket, time ?? new ManualTime(new DateTimeOffset(2026, 11, 8, 15, 0, 0, TimeSpan.Zero)), NullLogger<ProjectXMarketFeed>.Instance, depth);
        return (feed, socket, api);
    }
}
