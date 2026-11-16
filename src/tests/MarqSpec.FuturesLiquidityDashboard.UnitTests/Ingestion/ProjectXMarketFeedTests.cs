using MarqSpec.Client.ProjectX;
using MarqSpec.Client.ProjectX.Api.Models;
using MarqSpec.Client.ProjectX.WebSocket;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: ARCHITECTURE.md D-15 (contract resolution, settle-window snapshot)
public sealed class ProjectXMarketFeedTests
{
    private static readonly InstrumentSpec Es = InstrumentCatalog.MES with { ContractId = "MESZ6" };

    [Fact]
    public void PickContract_MatchesTheRootOnly_AndPrefersTheActiveContract()
    {
        Contract[] contracts =
        [
            new() { Id = "CON.F.US.MES.Z26", Name = "MESZ6", ActiveContract = true },
            new() { Id = "CON.F.US.EP.H27", Name = "ESH7", ActiveContract = false },
            new() { Id = "CON.F.US.EP.Z26", Name = "ESZ6", ActiveContract = true },
        ];

        ProjectXMarketFeed.PickContract(InstrumentRoot.MES, contracts)!.Id.Should().Be("CON.F.US.MES.Z26");
        ProjectXMarketFeed.PickContract(InstrumentRoot.MGC, contracts).Should().BeNull();
    }

    [Fact]
    public async Task Resolve_ShouldThrowAConfigurationError_WhenTheConfiguredContractIdIsUnknown()
    {
        var api = A.Fake<IProjectXApiClient>();
        A.CallTo(() => api.GetContractByIdAsync("CON.F.US.MES.TYPO", A<CancellationToken>._)).Returns((Contract?)null);
        var options = new ProjectXFeedOptions { ContractIds = { ["MES"] = "CON.F.US.MES.TYPO" } };
        var scopes = new ServiceCollection().AddSingleton(api).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        var feed = new ProjectXMarketFeed(options, scopes, A.Fake<IProjectXWebSocketClient>(), TimeProvider.System, NullLogger<ProjectXMarketFeed>.Instance);

        var resolve = () => feed.ResolveAsync(InstrumentSelection.Of(InstrumentRoot.MES), [InstrumentCatalog.MES], CancellationToken.None);

        (await resolve.Should().ThrowAsync<FeedConfigurationException>("a contract id that does not exist will not start to exist on a retry"))
            .Which.Message.Should().Contain("Feed:ProjectX:ContractIds:MES");
    }

    [Fact]
    public void ContractState_Connect_StartsANewEpochWithTheBookUnknown()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);

        var events = state.Connected(now: 1_000, settleMs: 1_500);

        events.Should().HaveCount(2);
        events[0].Should().BeOfType<FeedStatusEvent>().Which.Connected.Should().BeTrue();
        events[1].Should().BeOfType<BookResetEvent>();
        events.Should().OnlyContain(e => e.Epoch == 1);
        state.Building.Should().BeTrue();
    }

    [Fact]
    public async Task Stream_ShouldYieldQueuedTradesBeforeTheGap_WhenTheDropIsInTheSameRead()
    {
        const string gatewayId = "CON.F.US.EP.Z26";
        var api = A.Fake<IProjectXApiClient>();
        A.CallTo(() => api.GetContractByIdAsync(gatewayId, A<CancellationToken>._))
            .Returns(new Contract { Id = gatewayId, Name = "MESZ6", TickSize = 0.25m, ActiveContract = true });
        var socket = A.Fake<IProjectXWebSocketClient>();
        var options = new ProjectXFeedOptions { ContractIds = { ["MES"] = gatewayId } };
        var scopes = new ServiceCollection().AddSingleton(api).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        var feed = new ProjectXMarketFeed(
            options,
            scopes,
            socket,
            TimeProvider.System,
            NullLogger<ProjectXMarketFeed>.Instance,
            ingest: new IngestBufferOptions { TradeCapacity = 2 });
        await feed.ResolveAsync(InstrumentSelection.Of(InstrumentRoot.MES), [InstrumentCatalog.MES], CancellationToken.None);
        var raised = false;
        feed.BeforeRead = () =>
        {
            if (raised)
            {
                return;
            }

            raised = true;
            for (var i = 0; i < 3; i++)
            {
                socket.TradeUpdateReceived += Raise.With(socket, new TradeUpdate
                {
                    ContractId = gatewayId,
                    Price = 6800.25m,
                    Volume = 1,
                    Type = TradeLogType.Buy,
                    Timestamp = DateTime.SpecifyKind(TestData.Epoch.UtcDateTime.AddSeconds(i), DateTimeKind.Utc),
                });
            }
        };

        using var cts = new CancellationTokenSource();
        var events = new List<MarketEvent>();
        await using var run = feed.StreamAsync([InstrumentCatalog.MES], cts.Token).GetAsyncEnumerator(cts.Token);
        while (await run.MoveNextAsync())
        {
            events.Add(run.Current);
            if (run.Current is TradeGapEvent || events.Count > 12)
            {
                break;
            }
        }

        await cts.CancelAsync();
        var gapAt = events.FindIndex(e => e is TradeGapEvent);
        gapAt.Should().BeGreaterThan(0);
        events.Take(gapAt).Should().Contain(e => e is TradeEvent);
    }

    [Fact]
    public async Task Stream_ShouldClampAFutureStampAtArrival_WhenTakeRunsLater()
    {
        var gap = await EarlyDrop(TestData.Epoch.AddSeconds(90), TimeSpan.FromMinutes(2));

        gap.GapStartMs.Should().Be(TestData.EpochMs);
        gap.GapThroughMs.Should().Be(TestData.EpochMs);
    }

    [Fact]
    public async Task Stream_ShouldKeepAStampInsideTheClockWindow_WhenTakeRunsLater()
    {
        var gap = await EarlyDrop(TestData.Epoch.AddSeconds(30), TimeSpan.FromMinutes(2));

        gap.GapStartMs.Should().Be(TestData.EpochMs + 30_000);
        gap.GapThroughMs.Should().Be(TestData.EpochMs + 30_000);
    }

    [Fact]
    public async Task Stream_ShouldUseArrivalTime_WhenTheDroppedTradeHasNoTimestampAndTakeRunsLater()
    {
        var gap = await EarlyDrop(default, TimeSpan.FromMinutes(2));

        gap.GapStartMs.Should().Be(TestData.EpochMs);
        gap.GapThroughMs.Should().Be(TestData.EpochMs);
    }

    [Fact]
    public async Task StreamAsync_ARestartedStream_NeverReusesATradeIdTheEngineRemembers()
    {
        // Two stream runs on one feed, as IngestionService restarts it after a failure.
        const string gatewayId = "CON.F.US.EP.Z26";
        var api = A.Fake<IProjectXApiClient>();
        A.CallTo(() => api.GetContractByIdAsync(gatewayId, A<CancellationToken>._))
            .Returns(new Contract { Id = gatewayId, Name = "MESZ6", TickSize = 0.25m, ActiveContract = true });
        var socket = A.Fake<IProjectXWebSocketClient>();
        var options = new ProjectXFeedOptions { ContractIds = { ["MES"] = gatewayId } };
        var scopes = new ServiceCollection().AddSingleton(api).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        var feed = new ProjectXMarketFeed(options, scopes, socket, TimeProvider.System, NullLogger<ProjectXMarketFeed>.Instance);
        await feed.ResolveAsync(InstrumentSelection.Of(InstrumentRoot.MES), [InstrumentCatalog.MES], CancellationToken.None);

        async Task<TradeEvent> FirstTradeOfARun()
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using var run = feed.StreamAsync([InstrumentCatalog.MES], cts.Token).GetAsyncEnumerator(cts.Token);
            (await run.MoveNextAsync()).Should().BeTrue(); // connected
            (await run.MoveNextAsync()).Should().BeTrue(); // book reset
            socket.TradeUpdateReceived += Raise.With(socket, new TradeUpdate
            {
                ContractId = gatewayId,
                Price = 6800.25m,
                Volume = 1,
                Type = TradeLogType.Buy,
                Timestamp = DateTime.UtcNow,
            });
            while (await run.MoveNextAsync())
            {
                if (run.Current is TradeEvent trade)
                {
                    await cts.CancelAsync();
                    return trade;
                }
            }

            throw new InvalidOperationException("the stream ended without the trade");
        }

        var first = await FirstTradeOfARun();
        var second = await FirstTradeOfARun();

        second.TradeId.Should().NotBe(first.TradeId);
        second.Epoch.Should().BeGreaterThan(first.Epoch);
    }

    [Fact]
    public void ContractState_RowsDuringTheSettleWindow_BecomeOneSnapshot_ThenUpdatesFlow()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        state.Connected(1_000, 1_500);

        state.OnDepth(Row(DomType.Bid, 6800.00m, 10), 1_100, 1_500).Should().BeEmpty();
        state.OnDepth(Row(DomType.Bid, 6799.75m, 20), 1_200, 1_500).Should().BeEmpty();
        state.OnDepth(Row(DomType.Ask, 6800.25m, 15), 1_300, 1_500).Should().BeEmpty();
        state.OnDepth(Row(DomType.Bid, 6799.75m, 0), 1_400, 1_500).Should().BeEmpty(); // removed again
        state.TrySettle(2_000, 10).Should().BeNull("the window is not over yet");

        var snapshot = state.TrySettle(2_600, 10)!;

        snapshot.Bids.Should().Equal(new BookLevel(27200, 10));
        snapshot.Asks.Should().Equal(new BookLevel(27201, 15));
        state.Building.Should().BeFalse();
        state.OnDepth(Row(DomType.Ask, 6800.25m, 9), 2_700, 1_500).Should().ContainSingle()
            .Which.Should().BeOfType<DepthUpdateEvent>().Which.Quantity.Should().Be(9);
    }

    [Fact]
    public void ContractState_GatewayReset_RebuildsTheBook()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        state.Connected(0, 100);
        state.TrySettle(200, 10);

        state.OnDepth(Row(DomType.Reset, 0, 0), 300, 100).Should().ContainSingle().Which.Should().BeOfType<BookResetEvent>();
        state.Building.Should().BeTrue();
    }

    [Fact]
    public void ContractState_Disconnect_ReportsOnce_AndNoSnapshotIsSettledWhileDown()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        state.Connected(0, 100);

        state.Disconnected(50).Should().ContainSingle().Which.Should().BeOfType<FeedStatusEvent>().Which.Connected.Should().BeFalse();
        state.Disconnected(60).Should().BeEmpty();
        state.TrySettle(500, 10).Should().BeNull();
    }

    [Fact]
    public void ContractState_Sequences_OnlyGrow()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        var events = new List<MarketEvent>();
        events.AddRange(state.Connected(0, 100));
        events.Add(state.TrySettle(200, 10)!);
        events.AddRange(state.OnDepth(Row(DomType.Bid, 6800m, 1), 300, 100));
        events.Add(state.OnTrade(new TradeUpdate { Price = 6800m, Volume = 1, Type = TradeLogType.Buy }, 400)!);

        events.Select(e => e.Sequence).Should().BeInAscendingOrder().And.OnlyHaveUniqueItems();
    }

    [Fact]
    public async Task StreamAsync_ShouldCoalesceQuotesAndBoundTrades_WhenTheReaderIsBehind()
    {
        const string gatewayId = "CON.F.US.EP.Z26";
        var api = A.Fake<IProjectXApiClient>();
        A.CallTo(() => api.GetContractByIdAsync(gatewayId, A<CancellationToken>._))
            .Returns(new Contract { Id = gatewayId, Name = "MESZ6", TickSize = 0.25m, ActiveContract = true });
        var socket = A.Fake<IProjectXWebSocketClient>();
        var options = new ProjectXFeedOptions { ContractIds = { ["MES"] = gatewayId } };
        var ingest = new IngestBufferOptions { TradeCapacity = 4, DepthLevelsPerContract = 64 };
        var scopes = new ServiceCollection().AddSingleton(api).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        var feed = new ProjectXMarketFeed(options, scopes, socket, TimeProvider.System, NullLogger<ProjectXMarketFeed>.Instance, ingest: ingest);
        await feed.ResolveAsync(InstrumentSelection.Of(InstrumentRoot.MES), [InstrumentCatalog.MES], CancellationToken.None);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var run = feed.StreamAsync([InstrumentCatalog.MES], cts.Token).GetAsyncEnumerator(cts.Token);
        (await run.MoveNextAsync()).Should().BeTrue();
        (await run.MoveNextAsync()).Should().BeTrue();
        feed.Pressure.Should().NotBeNull();

        for (var i = 0; i < 40; i++)
        {
            socket.PriceUpdateReceived += Raise.With(socket, new PriceUpdate
            {
                ContractId = gatewayId,
                BestBid = 6800m + (i * 0.25m),
                BestAsk = 6800.25m + (i * 0.25m),
                Timestamp = DateTime.UtcNow,
            });
        }

        for (var i = 0; i < 10; i++)
        {
            socket.TradeUpdateReceived += Raise.With(socket, new TradeUpdate
            {
                ContractId = gatewayId,
                Price = 6800.25m,
                Volume = 1,
                Type = TradeLogType.Buy,
                Timestamp = DateTime.UtcNow,
            });
        }

        feed.Pressure!.QueuedQuoteCount.Should().Be(1);
        feed.Pressure.QueuedTradeCount.Should().Be(4);
        feed.Pressure.DroppedTrades.Should().Be(6);
        feed.Pressure.Coalesced.Should().Be(39);

        QuoteEvent? quote = null;
        TradeEvent? trades = null;
        var tradeCount = 0;
        var sawRecovery = false;
        while (await run.MoveNextAsync())
        {
            switch (run.Current)
            {
                case TradeGapEvent:
                    sawRecovery = true;
                    break;
                case QuoteEvent found:
                    quote = found;
                    break;
                case TradeEvent:
                    tradeCount++;
                    trades ??= (TradeEvent)run.Current;
                    break;
            }

            if (quote is not null && tradeCount == 4 && sawRecovery)
            {
                break;
            }
        }

        sawRecovery.Should().BeTrue("a dropped trade is reported after the trades that still fit");
        quote.Should().NotBeNull();
        quote!.BidTicks.Should().Be(InstrumentCatalog.MES.ToTicks(6800m + (39 * 0.25m)));
        tradeCount.Should().Be(4);
        trades.Should().NotBeNull();
        await cts.CancelAsync();
    }

    [Fact]
    public async Task StreamAsync_ShouldKeepADisconnectAndATrade_WhenTheyArriveBeforeTheStreamIsAccepted()
    {
        const string gatewayId = "CON.F.US.EP.Z26";
        var api = A.Fake<IProjectXApiClient>();
        A.CallTo(() => api.GetContractByIdAsync(gatewayId, A<CancellationToken>._))
            .Returns(new Contract { Id = gatewayId, Name = "MESZ6", TickSize = 0.25m, ActiveContract = true });
        var socket = A.Fake<IProjectXWebSocketClient>();
        A.CallTo(() => socket.ConnectMarketHubAsync(A<CancellationToken>._)).Invokes(() =>
        {
            socket.ConnectionStatusChanged += Raise.With(socket, new ConnectionStatusChange
            {
                PreviousState = ConnectionState.Connected,
                CurrentState = ConnectionState.Disconnected,
            });
            socket.TradeUpdateReceived += Raise.With(socket, new TradeUpdate
            {
                ContractId = gatewayId,
                Price = 6800.25m,
                Volume = 2,
                Type = TradeLogType.Buy,
                Timestamp = DateTime.UtcNow,
            });
        });
        var options = new ProjectXFeedOptions { ContractIds = { ["MES"] = gatewayId } };
        var scopes = new ServiceCollection().AddSingleton(api).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        var feed = new ProjectXMarketFeed(options, scopes, socket, TimeProvider.System, NullLogger<ProjectXMarketFeed>.Instance);
        await feed.ResolveAsync(InstrumentSelection.Of(InstrumentRoot.MES), [InstrumentCatalog.MES], CancellationToken.None);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var run = feed.StreamAsync([InstrumentCatalog.MES], cts.Token).GetAsyncEnumerator(cts.Token);
        var sawDisconnect = false;
        var sawTrade = false;
        while (await run.MoveNextAsync())
        {
            switch (run.Current)
            {
                case FeedStatusEvent { Connected: false }:
                    sawDisconnect = true;
                    break;
                case TradeEvent trade:
                    trade.Quantity.Should().Be(2);
                    sawTrade = true;
                    break;
            }

            if (sawDisconnect && sawTrade)
            {
                break;
            }
        }

        sawDisconnect.Should().BeTrue();
        sawTrade.Should().BeTrue();
        await cts.CancelAsync();
    }

    [Fact]
    public void BeginRecovery_ShouldLeaveTheBookRecoveringUntilTheSnapshot_WhenDepthOverflows()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in state.Connected(TestData.EpochMs, settleMs: 500))
        {
            engine.Apply(marketEvent);
        }

        engine.Apply(state.TrySettle(TestData.EpochMs + 500, 10)!);
        engine.Status().Code.Should().Be("LIVE");

        var repair = state.BeginRecovery(TestData.EpochMs + 600, settleMs: 500, IngestRecoveryKind.Depth);
        repair.Should().ContainSingle().Which.Should().BeOfType<BookResetEvent>()
            .Which.Reason.Should().Be(ProjectXMarketFeed.ContractState.IngestOverflowReason);
        engine.Apply(repair[0]);
        engine.Status().Code.Should().Be("RECOVERING");
        engine.Status().BookKnown.Should().BeFalse();
        state.Building.Should().BeTrue();

        engine.Apply(state.TrySettle(TestData.EpochMs + 1_200, 10)!);
        engine.Status().Code.Should().Be("LIVE");
        engine.Status().BookKnown.Should().BeTrue();
    }

    [Fact]
    public void BeginRecovery_ShouldStayDegradedUntilAResubscribeSnapshot_WhenATradeWasDropped()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in state.Connected(TestData.EpochMs, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        engine.Apply(state.TrySettle(TestData.EpochMs + 100, 10)!);
        var repair = state.BeginRecovery(TestData.EpochMs + 200, settleMs: 100, IngestRecoveryKind.Trades, gapStartMs: TestData.EpochMs + 50);
        repair.Should().ContainSingle().Which.Should().BeOfType<TradeGapEvent>();
        var gap = (TradeGapEvent)repair[0];
        gap.GapStartMs.Should().Be(TestData.EpochMs + 50);
        engine.MarkMissing(gap.GapStartMs);
        engine.Apply(new FeedStatusEvent
        {
            Root = Es.Root,
            ContractId = Es.ContractId,
            SourceTimeMs = TestData.EpochMs + 200,
            ReceivedTimeMs = TestData.EpochMs + 200,
            Epoch = gap.Epoch,
            Sequence = 0,
            Connected = true,
            Provenance = FeedProvenance.Live,
            DepthSubscribed = true,
        });
        engine.Status().Code.Should().Be("DEGRADED");
        engine.Apply(TestData.Snapshot(TestData.EpochMs + 400) with { Root = Es.Root, ContractId = Es.ContractId });
        engine.Status().Code.Should().Be("DEGRADED", "a snapshot that is not a resubscribe leaves the gap open");
        engine.Apply(new BookResetEvent
        {
            Root = Es.Root,
            ContractId = Es.ContractId,
            SourceTimeMs = TestData.EpochMs + 500,
            ReceivedTimeMs = TestData.EpochMs + 500,
            Epoch = 2,
            Sequence = 2,
            Reason = BookResetEvent.SubscribedReason,
        });
        engine.Apply(TestData.Snapshot(TestData.EpochMs + 600) with { Root = Es.Root, ContractId = Es.ContractId, Epoch = 2, Resubscribe = true });
        engine.Status().Code.Should().Be("LIVE");
        engine.Status().MissingSinceMs.Should().BeNull();
    }

    [Fact]
    public void StreamRestart_ShouldStayDegradedUntilTheTaggedBook_WhenDepthStaysOn()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in state.Connected(TestData.EpochMs, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        engine.Apply(state.TrySettle(TestData.EpochMs + 100, 10)!);
        var dropped = TestData.EpochMs + 50_000;
        engine.MarkMissing(dropped);

        foreach (var marketEvent in state.BeginRecovery(TestData.EpochMs + 60_000, settleMs: 100, IngestRecoveryKind.Depth))
        {
            engine.Apply(marketEvent);
        }

        var overflow = state.TrySettle(TestData.EpochMs + 60_100, 10)!;
        overflow.Resubscribe.Should().BeFalse();
        engine.Apply(overflow);
        engine.Status().Code.Should().Be("DEGRADED");

        foreach (var marketEvent in state.OnDepth(Row(DomType.Reset, 0, 0), TestData.EpochMs + 70_000, 100))
        {
            engine.Apply(marketEvent);
        }

        var gateway = state.TrySettle(TestData.EpochMs + 70_100, 10)!;
        gateway.Resubscribe.Should().BeFalse();
        engine.Apply(gateway);
        engine.Status().MissingSinceMs.Should().Be(dropped);

        foreach (var marketEvent in state.Disconnected(TestData.EpochMs + 80_000))
        {
            engine.Apply(marketEvent);
        }

        engine.Status().Code.Should().Be("RECOVERING");
        engine.Status().MissingSinceMs.Should().Be(dropped);
        foreach (var marketEvent in state.Connected(TestData.EpochMs + 90_000, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        engine.Status().MissingSinceMs.Should().Be(dropped, "the reconnect status is not the rebuilt book");
        var book = state.TrySettle(TestData.EpochMs + 90_100, 10)!;
        book.Resubscribe.Should().BeTrue();
        engine.Apply(book);
        engine.Status().Code.Should().Be("LIVE");
        engine.Status().MissingSinceMs.Should().BeNull();
        engine.Status().CvdKnown.Should().BeTrue("a fresh resubscribe snapshot anchors CVD again");
        engine.Snapshot(60, null).Profiles.Should().Contain(profile =>
            profile.Window == "session" && profile.MissingRanges.Any(range => range[0] == dropped));
    }

    [Fact]
    public void StreamRestart_ShouldClearOnTheNewerEpoch_WhenDepthIsOff()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in state.Connected(TestData.EpochMs, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        engine.Apply(state.TrySettle(TestData.EpochMs + 100, 10)!);
        var dropped = TestData.EpochMs + 50_000;
        engine.MarkMissing(dropped);
        foreach (var marketEvent in state.DepthOff(TestData.EpochMs + 60_000))
        {
            engine.Apply(marketEvent);
        }

        engine.Status().Code.Should().Be("DEGRADED", "turning depth off in the same epoch is not a resubscribe");
        foreach (var marketEvent in state.Disconnected(TestData.EpochMs + 70_000))
        {
            engine.Apply(marketEvent);
        }

        foreach (var marketEvent in state.Connected(TestData.EpochMs + 80_000, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        engine.Status().Code.Should().Be("LIVE");
        engine.Status().MissingSinceMs.Should().BeNull();
        engine.Status().CvdKnown.Should().BeTrue("the newer epoch is this contract's resubscribe");
        engine.Snapshot(60, null).Profiles.Should().Contain(profile =>
            profile.Window == "1h" && profile.MissingRanges.Any(range => range[0] == dropped && range[1] != null));
    }

    [Fact]
    public void OnDepth_ShouldRestartTheSettleWindow_WhenPendingPricesPassTheCap()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        state.Connected(0, settleMs: 1_000);
        state.OnDepth(Row(DomType.Bid, 6800.00m, 1), 10, 1_000, maxPendingLevels: 2).Should().BeEmpty();
        state.OnDepth(Row(DomType.Ask, 6800.25m, 1), 20, 1_000, maxPendingLevels: 2).Should().BeEmpty();

        var repair = state.OnDepth(Row(DomType.Bid, 6799.75m, 1), 30, 1_000, maxPendingLevels: 2);

        repair.Should().ContainSingle().Which.Should().BeOfType<BookResetEvent>()
            .Which.Reason.Should().Be(ProjectXMarketFeed.ContractState.IngestOverflowReason);
        state.Building.Should().BeTrue();
        state.TrySettle(40, 10).Should().BeNull("the window started again");
    }

    [Fact]
    public void Gap_ShouldEndAtTheGatewayTimestamp_WhenTheResubscribeBookSettles()
    {
        var exchange = new DateTime(2026, 11, 10, 14, 2, 0, DateTimeKind.Utc);
        var exchangeMs = new DateTimeOffset(exchange).ToUnixTimeMilliseconds();
        var state = new ProjectXMarketFeed.ContractState(Es);
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in state.Connected(TestData.EpochMs, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        engine.Apply(state.TrySettle(TestData.EpochMs + 100, 10)!);
        engine.MarkMissing(TestData.EpochMs + 30_000);
        foreach (var marketEvent in state.Disconnected(TestData.EpochMs + 40_000))
        {
            engine.Apply(marketEvent);
        }

        foreach (var marketEvent in state.Connected(TestData.EpochMs + 50_000, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        state.OnDepth(Row(DomType.Bid, 6800m, 4, exchange), TestData.EpochMs + 60_000, 100).Should().BeEmpty();
        var book = state.TrySettle(TestData.EpochMs + 70_000, 10)!;
        book.SourceTimeMs.Should().Be(TestData.EpochMs + 70_000);
        book.GatewayTimeMs.Should().Be(exchangeMs);
        book.ReceivedTimeMs.Should().Be(TestData.EpochMs + 70_000);
        book.Resubscribe.Should().BeTrue();
        engine.Apply(book);
        engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").MissingRanges
            .Single()[1].Should().Be(exchangeMs);
    }

    [Fact]
    public void Gap_ShouldEndAtTheLastTradeTimestamp_WhenDepthIsOff()
    {
        var exchange = new DateTime(2026, 11, 10, 14, 1, 30, DateTimeKind.Utc);
        var exchangeMs = new DateTimeOffset(exchange).ToUnixTimeMilliseconds();
        var state = new ProjectXMarketFeed.ContractState(Es);
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in state.Connected(TestData.EpochMs, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        engine.Apply(state.TrySettle(TestData.EpochMs + 100, 10)!);
        engine.Apply(state.OnTrade(new TradeUpdate { Price = 6800m, Volume = 1, Type = TradeLogType.Buy }, TestData.EpochMs + 200)!);
        engine.MarkMissing(TestData.EpochMs + 30_000);
        engine.Apply(state.OnTrade(new TradeUpdate { Price = 6800m, Volume = 1, Type = TradeLogType.Buy, Timestamp = exchange }, TestData.EpochMs + 40_000)!);
        foreach (var marketEvent in state.DepthOff(TestData.EpochMs + 45_000))
        {
            engine.Apply(marketEvent);
        }

        engine.Status().MissingSinceMs.Should().NotBeNull();
        foreach (var marketEvent in state.Disconnected(TestData.EpochMs + 50_000))
        {
            engine.Apply(marketEvent);
        }

        var connected = state.Connected(TestData.EpochMs + 80_000, settleMs: 100);
        var status = connected.Should().ContainSingle().Which.Should().BeOfType<FeedStatusEvent>().Subject;
        status.SourceTimeMs.Should().Be(TestData.EpochMs + 80_000);
        status.GatewayTimeMs.Should().Be(exchangeMs);
        foreach (var marketEvent in connected)
        {
            engine.Apply(marketEvent);
        }

        engine.Status().MissingSinceMs.Should().BeNull();
        engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "1h").MissingRanges
            .Single()[1].Should().Be(exchangeMs);
    }

    [Fact]
    public void Resubscribe_ShouldStillClearTheGap_WhenAQuoteIsStampedFarAhead()
    {
        var state = new ProjectXMarketFeed.ContractState(Es);
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in state.Connected(TestData.EpochMs, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        engine.Apply(state.TrySettle(TestData.EpochMs + 100, 10)!);
        engine.MarkMissing(TestData.EpochMs + 30_000);
        var validMs = TestData.EpochMs + 35_000;
        var valid = DateTimeOffset.FromUnixTimeMilliseconds(validMs).UtcDateTime;
        state.OnDepth(Row(DomType.Bid, 6800m, 5, valid), validMs, 100);
        var ahead = DateTimeOffset.FromUnixTimeMilliseconds(TestData.EpochMs + 40_000).AddMinutes(10).UtcDateTime;
        var quote = state.OnQuote(new PriceUpdate { BestBid = 6800m, BestAsk = 6800.25m, Timestamp = ahead }, TestData.EpochMs + 40_000)!;
        var rejected = engine.Status().RejectedEvents;
        engine.Apply(quote);
        engine.Status().RejectedEvents.Should().Be(rejected + 1);

        foreach (var marketEvent in state.Disconnected(TestData.EpochMs + 50_000))
        {
            engine.Apply(marketEvent);
        }

        foreach (var marketEvent in state.Connected(TestData.EpochMs + 60_000, settleMs: 100))
        {
            engine.Apply(marketEvent);
        }

        var book = state.TrySettle(TestData.EpochMs + 60_100, 10)!;
        book.SourceTimeMs.Should().Be(TestData.EpochMs + 60_100);
        book.GatewayTimeMs.Should().Be(validMs);
        book.Resubscribe.Should().BeTrue();
        engine.Apply(book);

        engine.Status().BookKnown.Should().BeTrue();
        engine.Status().Code.Should().Be("LIVE");
        engine.Status().MissingSinceMs.Should().BeNull();
        engine.Status().RejectedEvents.Should().Be(rejected + 1);
        engine.Snapshot(60, null).Profiles.Single(profile => profile.Window == "session").MissingRanges
            .Single()[1].Should().Be(validMs);
    }

    [Fact]
    public async Task StreamAsync_ShouldEmitASettledBook_WhenTheHubReportsConnectedBeforeAccept()
    {
        var events = await ReadHubAsync([ConnectionState.Connected], static seen => seen.OfType<DepthSnapshotEvent>().Any());

        SettledBook(events).Bids.Should().ContainSingle().Which.PriceTicks.Should().Be(InstrumentCatalog.MES.ToTicks(6800m));
    }

    [Fact]
    public async Task StreamAsync_ShouldEmitASettledBook_WhenConnectingThenConnectedArrivesBeforeAccept()
    {
        // ConnectMarketHubAsync reports Connecting before StartAsync, then Connected. That Connecting is not a drop.
        var events = await ReadHubAsync(
            [ConnectionState.Connecting, ConnectionState.Connected],
            static seen => seen.OfType<DepthSnapshotEvent>().Any());

        var snapshot = SettledBook(events);
        snapshot.Bids.Should().ContainSingle().Which.PriceTicks.Should().Be(InstrumentCatalog.MES.ToTicks(6800m));
        events.OfType<FeedStatusEvent>().Should().OnlyContain(status => status.Connected);
    }

    [Fact]
    public async Task StreamAsync_ShouldEmitASettledBook_WhenReconnectCompletesBeforeAccept()
    {
        // A drop that is already back to Connected before the stream emits its own status is not still down.
        var events = await ReadHubAsync(
            [ConnectionState.Connecting, ConnectionState.Connected, ConnectionState.Reconnecting, ConnectionState.Connected],
            static seen => seen.OfType<DepthSnapshotEvent>().Any());

        SettledBook(events).Bids.Should().ContainSingle().Which.PriceTicks.Should().Be(InstrumentCatalog.MES.ToTicks(6800m));
        events.OfType<FeedStatusEvent>().Should().OnlyContain(status => status.Connected);
    }

    [Fact]
    public async Task StreamAsync_ShouldSettleOnlyPostReconnectDepth_WhenADropFinishesBeforeAccept()
    {
        // Depth from before the mid-window drop must not remain in the book settled after Connected.
        var events = await ReadHubAsync(
            [],
            static seen => seen.OfType<DepthSnapshotEvent>().Any(),
            script: (socket, time) =>
            {
                var previous = ConnectionState.Disconnected;
                const string gatewayId = "CON.F.US.EP.Z26";
                previous = RaiseStatus(socket, previous, ConnectionState.Connecting);
                previous = RaiseStatus(socket, previous, ConnectionState.Connected);
                RaiseDepth(socket, gatewayId, 6799.00m, 3, time);
                previous = RaiseStatus(socket, previous, ConnectionState.Reconnecting);
                previous = RaiseStatus(socket, previous, ConnectionState.Connected);
                RaiseDepth(socket, gatewayId, 6801.25m, 8, time);
            });

        var snapshot = SettledBook(events);
        snapshot.Bids.Should().ContainSingle().Which.PriceTicks.Should().Be(InstrumentCatalog.MES.ToTicks(6801.25m));
        snapshot.Bids.Should().NotContain(level => level.PriceTicks == InstrumentCatalog.MES.ToTicks(6799.00m));
    }

    [Fact]
    public async Task StreamAsync_ShouldStayRecovering_WhenTheHubEndsDisconnectedBeforeAccept()
    {
        var events = await ReadHubAsync(
            [ConnectionState.Connecting, ConnectionState.Connected, ConnectionState.Disconnected],
            null);

        StillRecovering(events);
    }

    [Fact]
    public async Task StreamAsync_ShouldStayRecovering_WhenTheHubEndsReconnectingBeforeAccept()
    {
        // Reconnecting is SignalR's signal that an established connection has already dropped.
        var events = await ReadHubAsync(
            [ConnectionState.Connecting, ConnectionState.Connected, ConnectionState.Reconnecting],
            null);

        StillRecovering(events);
    }

    [Fact]
    public async Task StreamAsync_ShouldStayRecovering_WhenTheHubEndsConnectingBeforeAccept()
    {
        var events = await ReadHubAsync([ConnectionState.Connecting], null);

        StillRecovering(events);
    }

    [Fact]
    public async Task StreamAsync_ShouldStayRecovering_WhenTheHubEndsFailedBeforeAccept()
    {
        var events = await ReadHubAsync(
            [ConnectionState.Connecting, ConnectionState.Connected, ConnectionState.Failed],
            null);

        StillRecovering(events);
    }

    [Fact]
    public async Task StreamAsync_ShouldEmitASecondSettledBook_WhenTheHubReconnectsAfterTheFirstSnapshot()
    {
        var events = await ReadHubAsync(
            [ConnectionState.Connecting, ConnectionState.Connected],
            static seen => seen.OfType<DepthSnapshotEvent>().Count() >= 2,
            [ConnectionState.Reconnecting, ConnectionState.Connected]);

        SecondBook(events);
    }

    [Fact]
    public async Task StreamAsync_ShouldEmitASecondSettledBook_WhenConnectingThenConnectedFollowsTheFirstSnapshot()
    {
        // After the stream has accepted callbacks, Connecting then Connected is applied in order, so the settle restarts.
        var events = await ReadHubAsync(
            [ConnectionState.Connecting, ConnectionState.Connected],
            static seen => seen.OfType<DepthSnapshotEvent>().Count() >= 2,
            [ConnectionState.Connecting, ConnectionState.Connected]);

        SecondBook(events);
    }

    private static DepthSnapshotEvent SettledBook(IReadOnlyList<MarketEvent> events)
    {
        var snapshot = events.Should().ContainSingle(e => e is DepthSnapshotEvent).Which.Should().BeOfType<DepthSnapshotEvent>().Subject;
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in events)
        {
            engine.Apply(marketEvent);
        }

        engine.Status().BookKnown.Should().BeTrue();
        engine.Status().Code.Should().Be("LIVE");
        return snapshot;
    }

    private static void StillRecovering(IReadOnlyList<MarketEvent> events)
    {
        events.OfType<DepthSnapshotEvent>().Should().BeEmpty();
        var statuses = events.OfType<FeedStatusEvent>().ToList();
        statuses.Should().Contain(status => status.Connected);
        statuses.Should().HaveCountGreaterThan(0);
        statuses[^1].Connected.Should().BeFalse();
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in events)
        {
            engine.Apply(marketEvent);
        }

        engine.Status().BookKnown.Should().BeFalse();
        engine.Status().Code.Should().Be("RECOVERING");
    }

    private static void SecondBook(IReadOnlyList<MarketEvent> events)
    {
        var snapshots = events.OfType<DepthSnapshotEvent>().ToList();
        snapshots.Should().HaveCount(2);
        snapshots[0].Bids.Should().ContainSingle().Which.PriceTicks.Should().Be(InstrumentCatalog.MES.ToTicks(6800m));
        snapshots[1].Bids.Should().ContainSingle().Which.PriceTicks.Should().Be(InstrumentCatalog.MES.ToTicks(6800.25m));
        snapshots[1].Epoch.Should().BeGreaterThan(snapshots[0].Epoch);
        var first = events.ToList().FindIndex(e => e is DepthSnapshotEvent);
        var second = events.ToList().FindIndex(first + 1, e => e is DepthSnapshotEvent);
        events.Skip(first + 1).Take(second - first - 1).OfType<FeedStatusEvent>().Should().Contain(status => !status.Connected);
        var engine = new InstrumentEngine(Es, EngineOptions.Default, TestData.Calendar());
        foreach (var marketEvent in events)
        {
            engine.Apply(marketEvent);
        }

        engine.Status().BookKnown.Should().BeTrue();
        engine.Status().Code.Should().Be("LIVE");
    }

    /// <summary>
    /// Drives one stream. Hub statuses in <paramref name="duringConnect"/> are raised inside
    /// <c>ConnectMarketHubAsync</c>, while <c>accept</c> is still 0, and one bid is raised with them.
    /// The reader clock then jumps past the settle window. Statuses in <paramref name="afterFirstRead"/>
    /// are raised on the second read, after that first settle, and a second bid follows them.
    /// With a <paramref name="done"/> predicate the reader waits on the event it means, however long the runner takes
    /// to schedule it, bounded only by the 8 s token. With <c>null</c> the stream is expected to emit nothing more,
    /// so a read that blocks for a quiet window is that stream waiting with nothing further to emit.
    /// </summary>
    private static async Task<List<MarketEvent>> ReadHubAsync(
        IReadOnlyList<ConnectionState> duringConnect,
        Func<IReadOnlyList<MarketEvent>, bool>? done,
        IReadOnlyList<ConnectionState>? afterFirstRead = null,
        Action<IProjectXWebSocketClient, TimeProvider>? script = null)
    {
        const string gatewayId = "CON.F.US.EP.Z26";
        const int settleMs = 200;
        var time = new global::MarqSpec.FuturesLiquidityDashboard.UnitTests.Hubs.AdvanceableTime(TestData.Epoch);
        var api = A.Fake<IProjectXApiClient>();
        A.CallTo(() => api.GetContractByIdAsync(gatewayId, A<CancellationToken>._))
            .Returns(new Contract { Id = gatewayId, Name = "MESZ6", TickSize = 0.25m, ActiveContract = true });
        var socket = A.Fake<IProjectXWebSocketClient>();
        var previous = ConnectionState.Disconnected;
        A.CallTo(() => socket.ConnectMarketHubAsync(A<CancellationToken>._))
            .Invokes(() =>
            {
                if (script is not null)
                {
                    script(socket, time);
                    return;
                }

                foreach (var state in duringConnect)
                {
                    previous = RaiseStatus(socket, previous, state);
                }

                RaiseDepth(socket, gatewayId, 6800m, 4, time);
            })
            .Returns(Task.CompletedTask);
        var options = new ProjectXFeedOptions
        {
            ContractIds = { ["MES"] = gatewayId },
            Quotes = false,
            SnapshotSettleMs = settleMs,
        };
        var scopes = new ServiceCollection().AddSingleton(api).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        var feed = new ProjectXMarketFeed(options, scopes, socket, time, NullLogger<ProjectXMarketFeed>.Instance);
        await feed.ResolveAsync(InstrumentSelection.Of(InstrumentRoot.MES), [InstrumentCatalog.MES], CancellationToken.None);

        var read = 0;
        feed.BeforeRead = () =>
        {
            read++;
            if (read == 1)
            {
                time.Advance(TimeSpan.FromMilliseconds(500));
                return;
            }

            if (read == 2 && afterFirstRead is not null)
            {
                foreach (var state in afterFirstRead)
                {
                    previous = RaiseStatus(socket, previous, state);
                }

                RaiseDepth(socket, gatewayId, 6800.25m, 7, time);
                time.Advance(TimeSpan.FromMilliseconds(500));
            }
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        var events = new List<MarketEvent>();
        await using var run = feed.StreamAsync([InstrumentCatalog.MES], cts.Token).GetAsyncEnumerator(cts.Token);
        Task<bool>? pending = null;
        try
        {
            while (!cts.IsCancellationRequested)
            {
                pending = run.MoveNextAsync().AsTask();
                if (done is null)
                {
                    var finished = await Task.WhenAny(pending, Task.Delay(TimeSpan.FromMilliseconds(750)));
                    if (finished != pending)
                    {
                        break;
                    }
                }

                if (!await pending.ConfigureAwait(false))
                {
                    break;
                }

                events.Add(run.Current);
                if (done is not null && done(events))
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            await cts.CancelAsync();
            if (pending is { IsCompleted: false })
            {
                try
                {
                    await pending.ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                }
            }
        }

        return events;
    }

    private static ConnectionState RaiseStatus(IProjectXWebSocketClient socket, ConnectionState previous, ConnectionState current)
    {
        socket.ConnectionStatusChanged += Raise.With(socket, new ConnectionStatusChange
        {
            PreviousState = previous,
            CurrentState = current,
        });
        return current;
    }

    private static void RaiseDepth(IProjectXWebSocketClient socket, string gatewayId, decimal price, decimal volume, TimeProvider time)
    {
        var stamp = DateTime.SpecifyKind(time.GetUtcNow().UtcDateTime, DateTimeKind.Utc);
        socket.OrderBookUpdateReceived += Raise.With(socket, new OrderBookUpdate
        {
            ContractId = gatewayId,
            Type = DomType.Bid,
            Price = price,
            Volume = volume,
            Timestamp = stamp,
        });
    }

    private static OrderBookUpdate Row(DomType type, decimal price, decimal volume, DateTime timestamp = default) => new()
    {
        ContractId = "CON.F.US.EP.Z26",
        Type = type,
        Price = price,
        Volume = volume,
        Timestamp = timestamp,
    };

    /// <summary>
    /// One trade fits in the pre-connect buffer and the next is dropped. The clock then moves before
    /// <c>EarlyCallbacks.Take</c>, so a clamp that waits for Take sees a different now than the arrival.
    /// </summary>
    private static async Task<TradeGapEvent> EarlyDrop(DateTimeOffset droppedStamp, TimeSpan delayBeforeTake)
    {
        const string gatewayId = "CON.F.US.EP.Z26";
        var time = new global::MarqSpec.FuturesLiquidityDashboard.UnitTests.Hubs.AdvanceableTime(TestData.Epoch);
        var api = A.Fake<IProjectXApiClient>();
        A.CallTo(() => api.GetContractByIdAsync(gatewayId, A<CancellationToken>._))
            .Returns(new Contract { Id = gatewayId, Name = "MESZ6", TickSize = 0.25m, ActiveContract = true });
        var socket = A.Fake<IProjectXWebSocketClient>();
        A.CallTo(() => socket.ConnectMarketHubAsync(A<CancellationToken>._))
            .Invokes(() =>
            {
                RaiseTrade(socket, gatewayId, TestData.Epoch);
                RaiseTrade(socket, gatewayId, droppedStamp);
                time.Advance(delayBeforeTake);
            })
            .Returns(Task.CompletedTask);
        var options = new ProjectXFeedOptions { ContractIds = { ["MES"] = gatewayId }, Quotes = false };
        var scopes = new ServiceCollection().AddSingleton(api).BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        var feed = new ProjectXMarketFeed(
            options,
            scopes,
            socket,
            time,
            NullLogger<ProjectXMarketFeed>.Instance,
            ingest: new IngestBufferOptions { TradeCapacity = 1 });
        await feed.ResolveAsync(InstrumentSelection.Of(InstrumentRoot.MES), [InstrumentCatalog.MES], CancellationToken.None);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var events = new List<MarketEvent>();
        await using var run = feed.StreamAsync([InstrumentCatalog.MES], cts.Token).GetAsyncEnumerator(cts.Token);
        while (await run.MoveNextAsync())
        {
            events.Add(run.Current);
            if (run.Current is TradeGapEvent || events.Count > 8)
            {
                break;
            }
        }

        await cts.CancelAsync();
        return events.Should().ContainSingle(e => e is TradeGapEvent).Which.Should().BeOfType<TradeGapEvent>().Subject;
    }

    private static void RaiseTrade(IProjectXWebSocketClient socket, string gatewayId, DateTimeOffset stamp)
    {
        var timestamp = stamp == default ? default : DateTime.SpecifyKind(stamp.UtcDateTime, DateTimeKind.Utc);
        socket.TradeUpdateReceived += Raise.With(socket, new TradeUpdate
        {
            ContractId = gatewayId,
            Price = 6800.25m,
            Volume = 1,
            Type = TradeLogType.Buy,
            Timestamp = timestamp,
        });
    }
}
