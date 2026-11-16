using System.Globalization;
using System.Text.Json;
using FakeItEasy;
using MarqSpec.Client.ProjectX;
using MarqSpec.Client.ProjectX.Api.Models;
using MarqSpec.Client.ProjectX.WebSocket;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: gateway.docs.projectx.com realtime payloads; loginKey userName + apiKey
public sealed class ProjectXLiveContractTests
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    [Theory]
    [InlineData("StoppedForSessionConflict")]
    [InlineData("The connection stopped: session conflict")]
    public void IsConflict_ShouldMatchTheGatewayCloseReason_WhenTheOtherLoginWins(string message)
    {
        ProjectXSessionGuard.IsConflict(message).Should().BeTrue();
        ProjectXSessionGuard.IsConflict(new InvalidOperationException("wrapper", new HubExceptionStandIn(message))).Should().BeTrue();
    }

    [Fact]
    public void IsConflict_ShouldIgnoreAnOrdinaryDisconnect_WhenTheMessageIsATimeout()
    {
        ProjectXSessionGuard.IsConflict("The server did not answer in time.").Should().BeFalse();
        ProjectXSessionGuard.IsConflict((string?)null).Should().BeFalse();
    }

    [Fact]
    public void TryResolve_ShouldUseUsernameAndApiKey_WhenThoseAreTheLoginKeyFields()
    {
        var values = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["PROJECTX_USERNAME"] = "trader",
            ["PROJECTX_API_KEY"] = "key-value",
        };

        ProjectXLogin.TryResolve(key => values.GetValueOrDefault(key), out var pair).Should().BeTrue();
        pair.UserName.Should().Be("trader");
        pair.ApiKey.Should().Be("key-value");
    }

    [Fact]
    public void TryResolve_ShouldPreferUsernameAndApiKey_WhenBothPairsAreSet()
    {
        var values = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["PROJECTX_USERNAME"] = "trader",
            ["PROJECTX_API_KEY"] = "key-value",
            ["PROJECTX_API_SECRET"] = "older-secret",
        };

        ProjectXLogin.TryResolve(key => values.GetValueOrDefault(key), out var pair).Should().BeTrue();
        pair.Should().Be(new ProjectXLogin.Pair("trader", "key-value"));
    }

    [Fact]
    public void TryResolve_ShouldTreatTheLibraryPairAsUserNameThenKey_WhenUsernameIsAbsent()
    {
        var values = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["PROJECTX_API_KEY"] = "trader",
            ["PROJECTX_API_SECRET"] = "key-value",
        };

        ProjectXLogin.TryResolve(key => values.GetValueOrDefault(key), out var pair).Should().BeTrue();
        pair.Should().Be(new ProjectXLogin.Pair("trader", "key-value"));
    }

    [Fact]
    public void TryResolve_ShouldFail_WhenNothingIsSet()
    {
        ProjectXLogin.TryResolve(_ => null, out _).Should().BeFalse();
    }

    [Fact]
    public void PickContract_ShouldPreferTheActiveFrontMonth_WhenTheSymbolIdIsTheGatewayProduct()
    {
        Contract[] contracts =
        [
            new() { Id = "CON.F.US.MES.H26", Name = "MESH6", SymbolId = "F.US.MES", ActiveContract = false, TickSize = 0.25m },
            new() { Id = "CON.F.US.MES.M26", Name = "MESM6", SymbolId = "F.US.MES", ActiveContract = true, TickSize = 0.25m },
            new() { Id = "CON.F.US.EP.M26", Name = "ESM6", SymbolId = "F.US.EP", ActiveContract = true, TickSize = 0.25m },
        ];

        ProjectXMarketFeed.PickContract(InstrumentRoot.MES, contracts)!.Id.Should().Be("CON.F.US.MES.M26");
        ProjectXMarketFeed.PickContract(InstrumentRoot.MCL, contracts).Should().BeNull();
    }

    [Fact]
    public void SmokeTargets_ShouldBeTheThreeDefaultTabs_WhenTheCatalogListsEveryProduct()
    {
        ProjectXSmokeTargets.Roots.Should().Equal(InstrumentRoot.MES, InstrumentRoot.MCL, InstrumentRoot.MGC);
        InstrumentCatalog.All.Should().HaveCountGreaterThan(ProjectXSmokeTargets.Roots.Count);
        ProjectXSmokeTargets.Roots.Should().NotContain(InstrumentRoot.ES);
    }

    [Fact]
    public void PickContract_ShouldAcceptASymbolId_WhenTheNameIsNotAMonthCode()
    {
        var contracts = new[]
        {
            new Contract { Id = "CON.F.US.MGC.G27", Name = "Micro Gold", SymbolId = "F.US.MGC", ActiveContract = true, TickSize = 0.10m },
        };

        ProjectXMarketFeed.PickContract(InstrumentRoot.MGC, contracts)!.Id.Should().Be("CON.F.US.MGC.G27");
    }

    [Fact]
    public void GatewayPayloads_ShouldMapTheDocumentedQuoteTradeAndDepthShapes()
    {
        var quote = JsonSerializer.Deserialize<PriceUpdate>(
            """
            {"symbol":"F.US.MES","symbolName":"/MES","lastPrice":6815.75,"bestBid":6815.50,"bestAsk":6815.75,"change":5.25,"changePercent":0.08,"open":6810.50,"high":6820.00,"low":6800.25,"volume":12000,"lastUpdated":"2024-07-21T13:45:00Z","timestamp":"2024-07-21T13:45:00Z"}
            """,
            Json)!;
        var trade = JsonSerializer.Deserialize<TradeUpdate>(
            """
            {"symbolId":"F.US.MES","price":6815.75,"timestamp":"2024-07-21T13:45:00Z","type":0,"volume":2}
            """,
            Json)!;
        var depth = JsonSerializer.Deserialize<OrderBookUpdate>(
            """
            {"timestamp":"2024-07-21T13:45:00Z","type":2,"price":6815.50,"volume":10,"currentVolume":5}
            """,
            Json)!;

        quote.Symbol.Should().Be("F.US.MES");
        quote.LastPrice.Should().Be(6815.75m);
        quote.Timestamp.Kind.Should().Be(DateTimeKind.Utc);
        trade.Type.Should().Be(TradeLogType.Buy);
        trade.Volume.Should().Be(2);
        depth.Type.Should().Be(DomType.Bid);
        depth.CurrentVolume.Should().Be(5);
        var spec = InstrumentCatalog.MES;
        ProjectXEventMapper.Level(depth, spec)!.Value.Side.Should().Be(Core.Market.BookSide.Bid);
        ProjectXEventMapper.Trade(trade, spec, receivedMs: 1_721_566_700_000, epoch: 1, sequence: 1, null, null)!.Quantity.Should().Be(2);
        ProjectXEventMapper.ToUnixMs(quote.Timestamp, 0).Should().Be(DateTimeOffset.Parse("2024-07-21T13:45:00Z", CultureInfo.InvariantCulture).ToUnixTimeMilliseconds());
    }

    [Fact]
    public void SmokeReport_ShouldCountEachKindAndPrintUtcAndChicago()
    {
        var report = new ProjectXSmokeReport();
        var first = DateTimeOffset.Parse("2024-07-21T18:45:00Z", CultureInfo.InvariantCulture);
        var later = first.AddSeconds(2);
        report.Observe("MES", "quote", first, first.AddMilliseconds(40));
        report.Observe("MES", "trade", later, later.AddMilliseconds(80));
        report.Observe("MES", "depth", later, later.AddMilliseconds(90));

        var text = report.Render();

        text.Should().Contain("MES  quotes=1  trades=1  depth=1");
        text.Should().Contain("2024-07-21 18:45:00.000Z");
        text.Should().Contain("CT");
        text.Should().Contain("maxGapMs=2000");
    }

    [Fact]
    public async Task Ingestion_ShouldStop_WhenTheFeedReportsASessionConflict()
    {
        var feed = new ConflictFeed();
        var registry = new Core.Engine.EngineRegistry([InstrumentRoot.MES], Core.Engine.EngineOptions.Default, TestData.Calendar());
        var state = new IngestionState { FeedName = "projectx", Provenance = Core.Market.FeedProvenance.Live };
        var service = new IngestionService(
            feed,
            registry,
            Microsoft.Extensions.Options.Options.Create(new FeedOptions { Provider = FeedProvider.ProjectX }),
            TestData.Calendar(),
            state,
            TimeProvider.System,
            NullLogger<IngestionService>.Instance);

        await service.StartAsync(CancellationToken.None);
        try
        {
            var ready = false;
            using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (!ready)
            {
                ready = state.LastError is not null;
                await Task.Delay(20, wait.Token);
            }

            feed.Starts.Should().Be(1);
            state.LastError.Should().Be(ProjectXSessionConflictException.StopMessage);
            state.Ready.Should().BeFalse();
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StreamAsync_ShouldThrowSessionConflict_WhenTheHubCloseSaysSo()
    {
        const string gatewayId = "CON.F.US.MES.M26";
        var api = A.Fake<IProjectXApiClient>();
        A.CallTo(() => api.GetContractByIdAsync(gatewayId, A<CancellationToken>._))
            .Returns(new Contract { Id = gatewayId, Name = "MESM6", SymbolId = "F.US.MES", TickSize = 0.25m, ActiveContract = true });
        var socket = A.Fake<IProjectXWebSocketClient>();
        var scopes = new ServiceCollection().AddSingleton(api).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        var feed = new ProjectXMarketFeed(
            new ProjectXFeedOptions { ContractIds = { ["MES"] = gatewayId } },
            scopes,
            socket,
            TimeProvider.System,
            NullLogger<ProjectXMarketFeed>.Instance);
        await feed.ResolveAsync(InstrumentSelection.Of(InstrumentRoot.MES), [InstrumentCatalog.MES], CancellationToken.None);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await using var run = feed.StreamAsync([InstrumentCatalog.MES], cts.Token).GetAsyncEnumerator(cts.Token);
        (await run.MoveNextAsync()).Should().BeTrue();
        socket.ConnectionStatusChanged += Raise.With(socket, new ConnectionStatusChange
        {
            PreviousState = ConnectionState.Connected,
            CurrentState = ConnectionState.Disconnected,
            ErrorMessage = "StoppedForSessionConflict",
        });

        var act = async () =>
        {
            while (await run.MoveNextAsync())
            {
            }
        };
        await act.Should().ThrowAsync<ProjectXSessionConflictException>();
    }

    private sealed class HubExceptionStandIn(string message) : Exception(message);

    private sealed class ConflictFeed : IMarketDataFeed
    {
        public int Starts { get; private set; }

        public string Name => "projectx";

        public Core.Market.FeedProvenance Provenance => Core.Market.FeedProvenance.Live;

        public async IAsyncEnumerable<Core.Market.MarketEvent> StreamAsync(
            IReadOnlyList<InstrumentSpec> instruments,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
        {
            Starts++;
            await Task.Yield();
            throw new ProjectXSessionConflictException();
#pragma warning disable CS0162
            yield break;
#pragma warning restore CS0162
        }
    }
}
