using System.Diagnostics.Metrics;
using MarqSpec.FuturesLiquidityDashboard.Api.Hubs;
using MarqSpec.FuturesLiquidityDashboard.Api.Telemetry;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Hubs;

// reference: ARCHITECTURE.md D-32; REQUIREMENTS.md NFR-4
public sealed class PublishDispatchTests
{
    [Fact]
    public async Task PublishOnce_ShouldAbortTheConnection_WhenTheSendIsStillRunningAfterTheTimeout()
    {
        var (publisher, gate, watches, registry, time, calls, aborted) = Publisher();
        var engine = registry.All.Single();
        watches.Subscribe("slow", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, 24_000, 1, BookSide.Bid, "t"));

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        calls.Delta.Should().Be(1);

        time.Advance(TimeSpan.FromSeconds(1));
        await aborted.Task;

        calls.Delta.Should().Be(1);
        gate.TryStartDelta("slow", "MES", gate.Observe("slow")).Should().BeFalse();
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        calls.Delta.Should().Be(1);
        calls.Snapshot.Should().Be(0);
    }

    [Fact]
    public async Task PublishOnce_ShouldNotMarkAMiss_WhenTheOnlySendIsASnapshotOrEveryBrowserIsBusy()
    {
        var (publisher, gate, watches, registry, _, calls, _) = Publisher();
        var engine = registry.All.Single();
        watches.Subscribe("slow", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, 24_000, 1, BookSide.Bid, "t"));
        gate.MarkMissed("slow", "MES", gate.Observe("slow"));
        gate.Attach("slow", "MES", Task.CompletedTask, snapshot: false, gate.Observe("slow"));
        gate.Complete("slow", "MES");

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        calls.Snapshot.Should().Be(1);
        calls.Delta.Should().Be(0);

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        calls.Snapshot.Should().Be(1);
        gate.Complete("slow", "MES");
        gate.WantsSnapshot("slow", "MES").Should().BeFalse();
    }

    [Fact]
    public async Task PublishOnce_ShouldCoalesceADeltaBehindAnInFlightSnapshot_WhenAnotherBrowserIsIdle()
    {
        var (publisher, gate, watches, registry, _, calls, _) = Publisher();
        var engine = registry.All.Single();
        watches.Subscribe("slow", engine, 60, null);
        watches.Subscribe("fast", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, 24_000, 1, BookSide.Bid, "t1"));
        gate.Attach("slow", "MES", new TaskCompletionSource().Task, snapshot: true, gate.Observe("slow"));
        engine.Apply(TestData.Trade(TestData.EpochMs + 2, 24_000, 1, BookSide.Bid, "t2"));

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);

        calls.Delta.Should().Be(1, "only the idle browser is sent the delta");
        calls.Snapshot.Should().Be(0);
        gate.Complete("slow", "MES");
        gate.WantsSnapshot("slow", "MES").Should().BeTrue();
    }

    [Fact]
    public async Task PublishOnce_ShouldFlushBufferedDeltasInOrder_WhenSeveralSnapshotsComplete()
    {
        var rig = Rig("s1", "s2", "s3");
        await rig.Publish();
        await rig.Publish();
        await rig.ReleaseFirstDeltas();
        await rig.Publish();
        await rig.Publish();
        await rig.Publish();
        await rig.Publish();
        await rig.ReleaseSnapshots();
        await rig.Publish();

        foreach (var id in new[] { "s1", "s2", "s3", "fast" })
        {
            Resyncs(rig.Wire[id]).Should().BeFalse($"{id} stays contiguous");
        }

        rig.Wire["s1"].Should().Contain(message => message.Snapshot);
        rig.Wire["s1"].Count(message => message.Snapshot).Should().Be(1);
        rig.Wire["fast"].Should().OnlyContain(message => !message.Snapshot);
        var flushed = rig.Wire["s1"].Where(message => !message.Snapshot).Select(message => message.Seq).ToList();
        flushed.Should().BeInAscendingOrder();
    }

    [Fact]
    public async Task PublishOnce_ShouldSendOneLaterSnapshot_WhenTheDeltaBufferOverflows()
    {
        var rig = Rig("s1", "s2");
        await rig.Publish();
        await rig.Publish();
        await rig.ReleaseFirstDeltas();
        await rig.Publish();
        for (var tick = 0; tick < BrowserSendGate.CapacityFor(250) + 2; tick++)
        {
            await rig.Publish();
        }

        var before = rig.Wire["s1"].Count(message => message.Snapshot);
        await rig.ReleaseSnapshots();
        await rig.Publish();
        rig.Wire["s1"].Count(message => message.Snapshot).Should().Be(before, "the next snapshot waits out the 2 s limit");

        rig.Time.Advance(TimeSpan.FromSeconds(2));
        await rig.Publish();

        foreach (var id in new[] { "s1", "s2" })
        {
            rig.Wire[id].Count(message => message.Snapshot).Should().Be(before + 1);
            Resyncs(rig.Wire[id]).Should().BeFalse($"{id} has no sequence gap");
            var snapshots = rig.Wire[id].Where(message => message.Snapshot).Select(message => message.Seq).ToList();
            snapshots.Should().BeInAscendingOrder();
            snapshots[^1].Should().BeGreaterThan(snapshots[0]);
        }

        Resyncs(rig.Wire["fast"]).Should().BeFalse();

        await rig.Publish();
        await rig.Publish();
        foreach (var id in new[] { "s1", "s2" })
        {
            Resyncs(rig.Wire[id]).Should().BeFalse($"{id} resumes without a gap");
            var lastSnapshot = rig.Wire[id].FindLastIndex(message => message.Snapshot);
            var tail = rig.Wire[id].Skip(lastSnapshot + 1).ToList();
            tail.Should().NotBeEmpty();
            tail.Should().OnlyContain(message => !message.Snapshot);
            tail[0].Seq.Should().Be(rig.Wire[id][lastSnapshot].Seq + 1);
        }

        Resyncs(rig.Wire["fast"]).Should().BeFalse();
    }

    [Fact]
    public void Forget_ShouldDropTheConnectionSlot_WhenTheBrowserDisconnects()
    {
        var gate = new BrowserSendGate();
        gate.Attach("slow", "MES", new TaskCompletionSource().Task, snapshot: false, gate.Observe("slow"));
        gate.Forget("slow");

        gate.InFlight("slow", "MES").Should().BeFalse();
        gate.TryStartDelta("slow", "MES", gate.Observe("slow")).Should().BeTrue();
    }

    [Fact]
    public async Task Disconnect_ShouldNotRecreateASlot_WhenATickRunsBeforeForget()
    {
        var (publisher, gate, watches, registry, _, _, _) = Publisher();
        var engine = registry.All.Single();
        watches.Subscribe("slow", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, 24_000, 1, BookSide.Bid, "t"));
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        gate.HasSlot("slow", "MES").Should().BeTrue();

        // MarketHub.OnDisconnectedAsync drops the watch first, so a tick cannot recreate the slot.
        watches.Disconnect("slow");
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        gate.Forget("slow");
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);

        gate.HasSlot("slow", "MES").Should().BeFalse();
    }

    [Fact]
    public void Forget_ShouldRejectAStaleLookup_WhenTheTickAlreadyObservedTheConnection()
    {
        var gate = new BrowserSendGate();
        var observed = gate.Observe("slow");
        var delta = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar()).All.Single().Publish(null)!;
        gate.Attach("slow", "MES", Task.CompletedTask, snapshot: false, gate.Observe("slow"));
        gate.Forget("slow");

        gate.TryStartDelta("slow", "MES", observed).Should().BeFalse();
        gate.NoteSkipped("slow", "MES", observed).Should().BeFalse();
        gate.Offer("slow", "MES", delta, observed).Should().Be(-1);
        gate.TryStartSnapshot("slow", "MES", 1, 0, observed).Should().BeFalse();
        gate.MarkMissed("slow", "MES", observed);
        gate.Abandon("slow", "MES");
        gate.HasSlot("slow", "MES").Should().BeFalse();
        gate.TryStartDelta("slow", "MES", gate.Observe("slow")).Should().BeTrue();
    }

    [Fact]
    public void Forget_ShouldDropTrackedGenerations_WhenTheBrowserDisconnects()
    {
        var gate = new BrowserSendGate();
        var observed = gate.Observe("slow");
        gate.TrackedConnections.Should().Be(1);
        gate.Forget("slow");

        gate.TrackedConnections.Should().Be(0);
        gate.TryStartDelta("slow", "MES", observed).Should().BeFalse();

        var again = gate.Observe("slow");
        again.Should().NotBe(observed);
        gate.TryStartDelta("slow", "MES", again).Should().BeTrue();
        gate.TryStartDelta("slow", "MES", observed).Should().BeFalse();

        for (var i = 0; i < 20; i++)
        {
            var id = "conn-" + i;
            gate.Observe(id);
            gate.Forget(id);
        }

        gate.TrackedConnections.Should().Be(1);
    }

    [Fact]
    public async Task Forget_ShouldStayUntracked_WhenASnapshotSendFinishesAfterDisconnect()
    {
        var slowSend = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        BrowserSendGate gate = null!;
        var created = Publisher(
            duringSnapshotSend: () =>
            {
                gate.Forget("slow");
                slowSend.TrySetResult();
            },
            slowSend: slowSend);
        gate = created.Gate;
        var engine = created.Registry.All.Single();
        created.Watches.Subscribe("slow", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, 24_000, 1, BookSide.Bid, "t"));
        gate.MarkMissed("slow", "MES", gate.Observe("slow"));
        gate.Attach("slow", "MES", Task.CompletedTask, snapshot: false, gate.Observe("slow"));
        gate.Complete("slow", "MES");

        await created.Publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        await Task.Yield();

        gate.TrackedConnections.Should().Be(0);
        gate.HasSlot("slow", "MES").Should().BeFalse();
    }

    [Fact]
    public async Task PublishOnce_ShouldNotRecreateASlot_WhenDisconnectRunsAfterTheSubscriberWasChosen()
    {
        BrowserSendGate gate = null!;
        WatchTracker watches = null!;
        var created = Publisher(duringDeltaSend: () =>
        {
            watches.Disconnect("slow");
            gate.Forget("slow");
        });
        gate = created.Gate;
        watches = created.Watches;
        var engine = created.Registry.All.Single();
        watches.Subscribe("slow", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, 24_000, 1, BookSide.Bid, "t"));

        await created.Publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);

        gate.HasSlot("slow", "MES").Should().BeFalse();
    }

    [Fact]
    public async Task PublishOnce_ShouldSendOneSnapshot_WhenAFlushedDeltaFails()
    {
        var time = new AdvanceableTime(TestData.Epoch);
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var watches = new WatchTracker(registry, new DepthDemand(new DepthOptions(), time), new ConfigurationBuilder().Build());
        var engine = registry.All.Single();
        watches.Subscribe("slow", engine, 60, null);
        watches.Subscribe("fast", engine, 60, null);
        var wire = new List<Wire>();
        var firstDelta = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var snapshotGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var repair = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var deltaSends = 0;
        var snapshots = 0;
        var clients = A.Fake<IHubClients>();
        A.CallTo(() => clients.Client(A<string>._)).ReturnsLazily((string id) =>
        {
            var proxy = A.Fake<ISingleClientProxy>();
            A.CallTo(() => proxy.SendCoreAsync(A<string>._, A<object?[]>._, A<CancellationToken>._))
                .ReturnsLazily(call =>
                {
                    if (id == "fast")
                    {
                        return Task.CompletedTask;
                    }

                    var method = call.GetArgument<string>(0)!;
                    var payload = call.GetArgument<object?[]>(1)![0]!;
                    var isSnapshot = method == MarketHub.SnapshotMethod;
                    var seq = isSnapshot ? ((DashboardSnapshot)payload).Seq : ((DashboardDelta)payload).Seq;
                    wire.Add(new Wire(isSnapshot, seq));
                    if (isSnapshot)
                    {
                        snapshots++;
                        return snapshots == 1 ? snapshotGate.Task : repair.Task;
                    }

                    deltaSends++;
                    if (deltaSends == 1)
                    {
                        return firstDelta.Task;
                    }

                    var flushed = deltaSends - 1;
                    if (flushed == 2)
                    {
                        return Task.FromException(new IOException("flush failed"));
                    }

                    if (flushed > 2)
                    {
                        throw new InvalidOperationException("the batch continued after a failed send");
                    }

                    return Task.CompletedTask;
                });
            return proxy;
        });
        var hub = A.Fake<IHubContext<MarketHub>>();
        A.CallTo(() => hub.Clients).Returns(clients);
        var services = new ServiceCollection();
        services.AddMetrics();
        var gate = new BrowserSendGate();
        var publisher = new MarketPublisher(
            registry,
            new OverlayStore(time),
            watches,
            hub,
            time,
            new ConfigurationBuilder().Build(),
            new DashboardMetrics(services.BuildServiceProvider().GetRequiredService<IMeterFactory>(), registry),
            gate,
            NullLogger<MarketPublisher>.Instance);

        var trade = 0;
        async Task Publish()
        {
            trade++;
            engine.Apply(TestData.Trade(TestData.EpochMs + trade, 24_000, 1, BookSide.Bid, $"t{trade}"));
            await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        }

        await Publish();
        await Publish();
        var settled = gate.WhenSettled("slow", "MES");
        firstDelta.TrySetResult();
        await settled;
        await Publish();
        await Publish();
        await Publish();
        await Publish();
        settled = gate.WhenSettled("slow", "MES");
        snapshotGate.TrySetResult();
        await settled;

        deltaSends.Should().Be(3);
        wire.Count(message => message.Snapshot).Should().Be(1);
        await Publish();
        deltaSends.Should().Be(3);
        wire.Should().Contain(message => message.Snapshot);
        wire[^1].Snapshot.Should().BeTrue();
        Resyncs(wire).Should().BeFalse();
        var released = gate.WhenSettled("slow", "MES");
        repair.TrySetResult();
        await released;
    }

    [Fact]
    public async Task PublishOnce_ShouldKeepTheBufferCap_WhenAnotherTickRuns()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Api:PublishMs"] = "250",
            ["Api:PublishTimeoutMs"] = "30000",
        }).Build();
        var (publisher, gate, _, _, _, _, _) = Publisher(configuration);

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        gate.BufferCapacity.Should().Be(BrowserSendGate.CapacityFor(250, 30_000));
        gate.BufferCapacity = 3;
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        gate.BufferCapacity.Should().Be(3);
    }

    [Fact]
    public void CapacityFor_ShouldCoverTheSendTimeout_WhenItIsLongerThanTheCatchUpInterval()
    {
        BrowserSendGate.CapacityFor(250, 1_000).Should().Be(8);
        BrowserSendGate.CapacityFor(250, 30_000).Should().Be(120);
        BrowserSendGate.CapacityFor(50, 50).Should().Be(BrowserSendGate.CatchUpIntervalMs / 50);
    }

    [Fact]
    public async Task PublishOnce_ShouldCountASkippedDelta_WhenThePreviousSendIsStillRunning()
    {
        var meters = NewMeterFactory();
        var skipped = ListenSkipped(meters);
        var (publisher, _, watches, registry, _, calls, _) = Publisher(meters: meters);
        var engine = registry.All.Single();
        watches.Subscribe("slow", engine, 60, null);
        watches.Subscribe("fast", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, 24_000, 1, BookSide.Bid, "t1"));

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        skipped().Should().Be(0);
        engine.Apply(TestData.Trade(TestData.EpochMs + 2, 24_000, 1, BookSide.Bid, "t2"));
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        skipped().Should().Be(1);
        calls.Delta.Should().BeGreaterThan(1);
    }

    [Fact]
    public async Task PublishOnce_ShouldNotCountABufferedDelta_WhenASnapshotIsInFlight()
    {
        var meters = NewMeterFactory();
        var skipped = ListenSkipped(meters);
        var (publisher, gate, watches, registry, _, _, _) = Publisher(meters: meters);
        var engine = registry.All.Single();
        watches.Subscribe("slow", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, 24_000, 1, BookSide.Bid, "t"));
        gate.MarkMissed("slow", "MES", gate.Observe("slow"));
        gate.Attach("slow", "MES", Task.CompletedTask, snapshot: false, gate.Observe("slow"));
        gate.Complete("slow", "MES");

        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        var held = skipped();
        held.Should().Be(1, "the tick that opens the snapshot is not delivered as a delta");
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        skipped().Should().Be(held, "a delta held behind the snapshot is sent later, so it is not a skip");
    }

    [Fact]
    public async Task PublishOnce_ShouldCountDiscardedDeltas_WhenTheBufferOverflows()
    {
        var meters = NewMeterFactory();
        var skipped = ListenSkipped(meters);
        var (publisher, gate, watches, registry, _, _, _) = Publisher(meters: meters);
        var engine = registry.All.Single();
        watches.Subscribe("slow", engine, 60, null);
        engine.Apply(TestData.Trade(TestData.EpochMs + 1, 24_000, 1, BookSide.Bid, "t"));
        gate.MarkMissed("slow", "MES", gate.Observe("slow"));
        gate.Attach("slow", "MES", Task.CompletedTask, snapshot: false, gate.Observe("slow"));
        gate.Complete("slow", "MES");
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        var baseline = skipped();

        var capacity = gate.BufferCapacity;
        for (var tick = 0; tick < capacity; tick++)
        {
            await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        }

        skipped().Should().Be(baseline);
        await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        skipped().Should().Be(baseline + capacity + 1);
    }

    private static IMeterFactory NewMeterFactory()
    {
        var services = new ServiceCollection();
        services.AddMetrics();
        return services.BuildServiceProvider().GetRequiredService<IMeterFactory>();
    }

    // A meter made by a factory carries that factory as its Scope, so matching on it counts only the
    // instruments this test's own DashboardMetrics created, not those of a test running beside it.
    private static Func<long> ListenSkipped(IMeterFactory meters)
    {
        long total = 0;
        var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (ReferenceEquals(instrument.Meter.Scope, meters) && instrument.Name == "fld.publish.skipped")
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };

        listener.SetMeasurementEventCallback<long>((_, value, _, _) => Interlocked.Add(ref total, value));
        listener.Start();
        return () =>
        {
            _ = listener;
            return Interlocked.Read(ref total);
        };
    }

    /// <summary>
    /// The seq rules of src/dashboard/src/domain/sequencer.ts, starting from the subscribe snapshot at seq 0.
    /// A snapshot replaces the state and then applies buffered deltas above it; a delta applies only when it is the next seq.
    /// </summary>
    private static bool Resyncs(IReadOnlyList<Wire> messages)
    {
        long state = 0;
        foreach (var message in messages)
        {
            if (message.Snapshot)
            {
                state = message.Seq;
                continue;
            }

            if (message.Seq <= state)
            {
                continue;
            }

            if (message.Seq != state + 1)
            {
                return true;
            }

            state = message.Seq;
        }

        return false;
    }

    private static PublishRig Rig(params string[] slows)
    {
        var time = new AdvanceableTime(TestData.Epoch);
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var watches = new WatchTracker(registry, new DepthDemand(new DepthOptions(), time), new ConfigurationBuilder().Build());
        var engine = registry.All.Single();
        var slowSet = slows.ToHashSet(StringComparer.Ordinal);
        foreach (var id in slows)
        {
            watches.Subscribe(id, engine, 60, null);
        }

        watches.Subscribe("fast", engine, 60, null);
        var wire = new Dictionary<string, List<Wire>>(StringComparer.Ordinal);
        var firstDelta = new Dictionary<string, TaskCompletionSource>(StringComparer.Ordinal);
        var snapshot = new Dictionary<string, TaskCompletionSource>(StringComparer.Ordinal);
        foreach (var id in slows.Append("fast"))
        {
            wire[id] = [];
            firstDelta[id] = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            snapshot[id] = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        var opened = new HashSet<string>(StringComparer.Ordinal);
        var clients = A.Fake<IHubClients>();
        A.CallTo(() => clients.Client(A<string>._)).ReturnsLazily((string id) =>
        {
            var proxy = A.Fake<ISingleClientProxy>();
            A.CallTo(() => proxy.SendCoreAsync(A<string>._, A<object?[]>._, A<CancellationToken>._))
                .ReturnsLazily(call =>
                {
                    var method = call.GetArgument<string>(0);
                    var payload = call.GetArgument<object?[]>(1)![0];
                    var seq = payload switch
                    {
                        DashboardDelta delta => delta.Seq,
                        DashboardSnapshot shot => shot.Seq,
                        _ => throw new InvalidOperationException("unexpected payload"),
                    };
                    var isSnapshot = method == MarketHub.SnapshotMethod;
                    wire[id].Add(new Wire(isSnapshot, seq));
                    if (!slowSet.Contains(id))
                    {
                        return Task.CompletedTask;
                    }

                    if (isSnapshot)
                    {
                        return snapshot[id].Task;
                    }

                    return opened.Add(id) ? firstDelta[id].Task : Task.CompletedTask;
                });
            return proxy;
        });
        var hub = A.Fake<IHubContext<MarketHub>>();
        A.CallTo(() => hub.Clients).Returns(clients);
        var services = new ServiceCollection();
        services.AddMetrics();
        var gate = new BrowserSendGate();
        var publisher = new MarketPublisher(
            registry,
            new OverlayStore(time),
            watches,
            hub,
            time,
            new ConfigurationBuilder().Build(),
            new DashboardMetrics(services.BuildServiceProvider().GetRequiredService<IMeterFactory>(), registry),
            gate,
            NullLogger<MarketPublisher>.Instance);
        return new PublishRig(publisher, gate, engine, time, wire, firstDelta, snapshot, slows);
    }

    private sealed record Wire(bool Snapshot, long Seq);

    private sealed class PublishRig(
        MarketPublisher publisher,
        BrowserSendGate gate,
        InstrumentEngine engine,
        AdvanceableTime time,
        Dictionary<string, List<Wire>> wire,
        Dictionary<string, TaskCompletionSource> firstDelta,
        Dictionary<string, TaskCompletionSource> snapshot,
        string[] slows)
    {
        private int _trade;

        public AdvanceableTime Time { get; } = time;

        public Dictionary<string, List<Wire>> Wire { get; } = wire;

        public async Task Publish()
        {
            _trade++;
            engine.Apply(TestData.Trade(TestData.EpochMs + _trade, 24_000, 1, BookSide.Bid, $"t{_trade}"));
            await publisher.PublishOnceAsync(TimeSpan.FromSeconds(1), CancellationToken.None);
        }

        public async Task ReleaseFirstDeltas()
        {
            foreach (var id in slows)
            {
                var settled = gate.WhenSettled(id, "MES");
                firstDelta[id].TrySetResult();
                await settled;
            }
        }

        public async Task ReleaseSnapshots()
        {
            foreach (var id in slows)
            {
                var settled = gate.WhenSettled(id, "MES");
                snapshot[id].TrySetResult();
                await settled;
            }
        }
    }

    private static (MarketPublisher Publisher, BrowserSendGate Gate, WatchTracker Watches, EngineRegistry Registry, AdvanceableTime Time, SendCounts Calls, TaskCompletionSource Aborted) Publisher(
        IConfiguration? configuration = null,
        Action? duringDeltaSend = null,
        Action? duringSnapshotSend = null,
        TaskCompletionSource? slowSend = null,
        IMeterFactory? meters = null)
    {
        var time = new AdvanceableTime(TestData.Epoch);
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var watches = new WatchTracker(registry, new DepthDemand(new DepthOptions(), time), new ConfigurationBuilder().Build());
        var context = A.Fake<HubCallerContext>();
        A.CallTo(() => context.ConnectionId).Returns("slow");
        var aborted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        A.CallTo(() => context.Abort()).Invokes(() => aborted.TrySetResult());
        watches.Attach(context);

        var calls = new SendCounts();
        var hanging = slowSend ?? new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var clients = A.Fake<IHubClients>();
        A.CallTo(() => clients.Client(A<string>._)).ReturnsLazily((string id) =>
        {
            var proxy = A.Fake<ISingleClientProxy>();
            A.CallTo(() => proxy.SendCoreAsync(MarketHub.DeltaMethod, A<object?[]>._, A<CancellationToken>._))
                .Invokes(() =>
                {
                    calls.Delta++;
                    if (id != "fast")
                    {
                        duringDeltaSend?.Invoke();
                    }
                })
                .Returns(id == "fast" ? Task.CompletedTask : hanging.Task);
            A.CallTo(() => proxy.SendCoreAsync(MarketHub.SnapshotMethod, A<object?[]>._, A<CancellationToken>._))
                .Invokes(() =>
                {
                    calls.Snapshot++;
                    if (id != "fast")
                    {
                        duringSnapshotSend?.Invoke();
                    }
                })
                .Returns(id == "fast" ? Task.CompletedTask : hanging.Task);
            return proxy;
        });
        var hub = A.Fake<IHubContext<MarketHub>>();
        A.CallTo(() => hub.Clients).Returns(clients);

        var metrics = new DashboardMetrics(meters ?? NewMeterFactory(), registry);
        var gate = new BrowserSendGate();
        var publisher = new MarketPublisher(
            registry,
            new OverlayStore(time),
            watches,
            hub,
            time,
            configuration ?? new ConfigurationBuilder().Build(),
            metrics,
            gate,
            NullLogger<MarketPublisher>.Instance);
        return (publisher, gate, watches, registry, time, calls, aborted);
    }

    private sealed class SendCounts
    {
        public int Delta { get; set; }

        public int Snapshot { get; set; }
    }
}

/// <summary>A clock whose timers fire when a test advances it.</summary>
internal sealed class AdvanceableTime(DateTimeOffset start) : TimeProvider
{
    private readonly object _gate = new();
    private readonly List<Scheduled> _timers = [];
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan by)
    {
        List<Scheduled> due;
        lock (_gate)
        {
            _now += by;
            due = _timers.Where(timer => !timer.Fired && timer.Due <= _now).ToList();
        }

        foreach (var timer in due)
        {
            timer.Fire();
        }
    }

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        var due = dueTime == Timeout.InfiniteTimeSpan ? DateTimeOffset.MaxValue : _now + dueTime;
        var timer = new Scheduled(callback, state, due);
        lock (_gate)
        {
            _timers.Add(timer);
        }

        if (dueTime <= TimeSpan.Zero)
        {
            timer.Fire();
        }

        return timer;
    }

    private sealed class Scheduled(TimerCallback callback, object? state, DateTimeOffset due) : ITimer
    {
        public DateTimeOffset Due { get; private set; } = due;

        public bool Fired { get; private set; }

        public void Fire()
        {
            if (Fired)
            {
                return;
            }

            Fired = true;
            callback(state);
        }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            Due = dueTime == Timeout.InfiniteTimeSpan ? DateTimeOffset.MaxValue : Due + dueTime;
            Fired = false;
            return true;
        }

        public void Dispose() => Fired = true;

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
