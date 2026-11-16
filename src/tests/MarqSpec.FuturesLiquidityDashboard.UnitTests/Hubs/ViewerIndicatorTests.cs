using MarqSpec.FuturesLiquidityDashboard.Api.Hubs;
using MarqSpec.FuturesLiquidityDashboard.Api.Telemetry;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Hubs;

public sealed class ViewerIndicatorTests
{
    [Fact]
    public void ForIndicatorMinutes_ShouldKeepOneTimeframe_WhenTheSnapshotCarriesAllThree()
    {
        var engine = WatchedEngine();
        var snapshot = engine.Snapshot(60, null);

        snapshot.Indicators.Select(series => series.Tf).Distinct().Should().BeEquivalentTo([60, 300, 900]);

        var five = snapshot.ForIndicatorMinutes(5);

        five.Seq.Should().Be(snapshot.Seq);
        five.Indicators.Should().NotBeEmpty();
        five.Indicators.Should().OnlyContain(series => series.Tf == 300);
        five.Indicators.Select(series => series.Id).Should().BeEquivalentTo(
            snapshot.Indicators.Where(series => series.Tf == 300).Select(series => series.Id));
        snapshot.Indicators.Select(series => series.Tf).Distinct().Should().BeEquivalentTo([60, 300, 900]);
    }

    [Fact]
    public void ForIndicatorMinutes_ShouldKeepOneTimeframe_WhenTheDeltaCarriesAllThree()
    {
        var engine = WatchedEngine();
        var delta = engine.Publish(null);

        delta.Indicators.Select(series => series.Tf).Distinct().Should().BeEquivalentTo([60, 300, 900]);

        var fifteen = delta.ForIndicatorMinutes(15);

        fifteen.Seq.Should().Be(delta.Seq);
        fifteen.Root.Should().Be(delta.Root);
        fifteen.Indicators.Should().NotBeEmpty();
        fifteen.Indicators.Should().OnlyContain(series => series.Tf == 900);
        delta.Indicators.Select(series => series.Tf).Distinct().Should().BeEquivalentTo([60, 300, 900]);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    [InlineData(60)]
    public void ForIndicatorMinutes_ShouldReadAnyOtherValueAsOneMinute_WhenTheMinutesAreNotAViewerChoice(int minutes)
    {
        var snapshot = WatchedEngine().Snapshot(60, null).ForIndicatorMinutes(minutes);

        snapshot.Indicators.Should().NotBeEmpty();
        snapshot.Indicators.Should().OnlyContain(series => series.Tf == 60);
    }

    [Fact]
    public void Subscribe_ShouldReturnOnlyTheRequestedTimeframe_WhenTheViewerResubscribes()
    {
        var (watches, engine) = Tracker();
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, TestData.EsBase, 1, BookSide.Bid, "t1"));

        var first = watches.Subscribe("a", engine, 30, null, indicatorMinutes: 1);
        watches.SetIndicatorMinutes("a", engine.Spec.Root, 15);
        var again = watches.Subscribe("a", engine, 30, null);

        first.Indicators.Should().OnlyContain(series => series.Tf == 60);
        again.Indicators.Should().OnlyContain(series => series.Tf == 900);
        again.Seq.Should().Be(first.Seq);
        watches.IndicatorMinutes("a", engine.Spec.Root).Should().Be(15);
        watches.HistoryMinutes("a", engine.Spec.Root).Should().Be(30);
        engine.Watchers.Should().Be(1);
    }

    [Fact]
    public async Task PublishOnce_ShouldSendEachViewerOnlyItsIndicatorTimeframe_WhenTwoConnectionsDiffer()
    {
        var (publisher, watches, engine, sent) = Publisher();
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, TestData.EsBase, 1, BookSide.Bid, "t1"));
        watches.SetIndicatorMinutes("one", engine.Spec.Root, 1);
        watches.Subscribe("one", engine, 60, null);
        watches.SetIndicatorMinutes("fifteen", engine.Spec.Root, 15);
        watches.Subscribe("fifteen", engine, 60, null);

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);

        var one = sent["one"].Single(message => !message.IsSnapshot).Delta!;
        var fifteen = sent["fifteen"].Single(message => !message.IsSnapshot).Delta!;
        one.Indicators.Should().NotBeEmpty().And.OnlyContain(series => series.Tf == 60);
        fifteen.Indicators.Should().NotBeEmpty().And.OnlyContain(series => series.Tf == 900);
        one.Indicators.Select(series => series.Id).Should().BeEquivalentTo(fifteen.Indicators.Select(series => series.Id));
        fifteen.Seq.Should().Be(one.Seq);
    }

    [Fact]
    public async Task PublishOnce_ShouldSendTheNewTimeframe_WhenTheViewerSubscribesAgain()
    {
        var (publisher, watches, engine, sent) = Publisher();
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, TestData.EsBase, 1, BookSide.Bid, "t1"));
        watches.SetIndicatorMinutes("a", engine.Spec.Root, 1);
        watches.Subscribe("a", engine, 60, null);

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        var before = sent["a"].Single(message => !message.IsSnapshot).Delta!;
        watches.SetIndicatorMinutes("a", engine.Spec.Root, 5);
        watches.Subscribe("a", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 2, TestData.EsBase, 1, BookSide.Bid, "t2"));
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        var after = sent["a"].Last(message => !message.IsSnapshot).Delta!;

        before.Indicators.Should().OnlyContain(series => series.Tf == 60);
        after.Indicators.Should().NotBeEmpty().And.OnlyContain(series => series.Tf == 300);
        after.Seq.Should().Be(before.Seq + 1);
    }

    [Fact]
    public async Task PublishOnce_ShouldCarryOnlyTheViewerTimeframe_WhenACatchUpSnapshotFollowsAMiss()
    {
        var (publisher, watches, engine, sent) = Publisher();
        var gate = sent.Gate;
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, TestData.EsBase, 1, BookSide.Bid, "t1"));
        watches.Subscribe("slow", engine, 60, null, indicatorMinutes: 5);
        gate.MarkMissed("slow", "MES", gate.Observe("slow"));
        gate.Attach("slow", "MES", Task.CompletedTask, snapshot: false, gate.Observe("slow"));
        gate.Complete("slow", "MES");

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);

        var snapshot = sent["slow"].Single(message => message.IsSnapshot).Snapshot!;
        snapshot.Indicators.Should().NotBeEmpty().And.OnlyContain(series => series.Tf == 300);
        sent["slow"].Should().NotContain(message => !message.IsSnapshot);
    }

    private static InstrumentEngine WatchedEngine()
    {
        var (_, engine) = Tracker();
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, TestData.EsBase, 1, BookSide.Bid, "open"));
        engine.Watch(60, null);
        return engine;
    }

    private static (WatchTracker Watches, InstrumentEngine Engine) Tracker()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var watches = new WatchTracker(registry, new DepthDemand(new DepthOptions(), TimeProvider.System), new ConfigurationBuilder().Build());
        return (watches, registry.All.Single());
    }

    private static (MarketPublisher Publisher, WatchTracker Watches, InstrumentEngine Engine, Sent Sent) Publisher()
    {
        var time = TimeProvider.System;
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var watches = new WatchTracker(registry, new DepthDemand(new DepthOptions(), time), new ConfigurationBuilder().Build());
        var sent = new Sent();
        var clients = A.Fake<IHubClients>();
        A.CallTo(() => clients.Client(A<string>._)).ReturnsLazily((string id) => Proxy(sent, id));
        var hub = A.Fake<IHubContext<MarketHub>>();
        A.CallTo(() => hub.Clients).Returns(clients);
        var services = new ServiceCollection();
        services.AddMetrics();
        var publisher = new MarketPublisher(
            registry,
            new OverlayStore(time),
            watches,
            hub,
            time,
            new ConfigurationBuilder().Build(),
            new DashboardMetrics(services.BuildServiceProvider().GetRequiredService<System.Diagnostics.Metrics.IMeterFactory>(), registry),
            sent.Gate,
            NullLogger<MarketPublisher>.Instance);
        return (publisher, watches, registry.All.Single(), sent);
    }

    private static ISingleClientProxy Proxy(Sent sent, string id)
    {
        var proxy = A.Fake<ISingleClientProxy>();
        A.CallTo(() => proxy.SendCoreAsync(A<string>._, A<object?[]>._, A<CancellationToken>._))
            .Invokes(call =>
            {
                var method = call.GetArgument<string>(0);
                var args = call.GetArgument<object?[]>(1)!;
                var isSnapshot = method == MarketHub.SnapshotMethod;
                sent.Add(id, new SentMessage(
                    isSnapshot,
                    isSnapshot ? (DashboardSnapshot)args[0]! : null,
                    isSnapshot ? null : (DashboardDelta)args[0]!));
            })
            .Returns(Task.CompletedTask);
        return proxy;
    }

    private sealed class Sent
    {
        private readonly Dictionary<string, List<SentMessage>> _messages = [];

        public BrowserSendGate Gate { get; } = new();

        public List<SentMessage> this[string id] => _messages[id];

        public void Add(string id, SentMessage message)
        {
            if (!_messages.TryGetValue(id, out var list))
            {
                list = [];
                _messages[id] = list;
            }

            list.Add(message);
        }
    }

    private sealed record SentMessage(bool IsSnapshot, DashboardSnapshot? Snapshot, DashboardDelta? Delta);
}
