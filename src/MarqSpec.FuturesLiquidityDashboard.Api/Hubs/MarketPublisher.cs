using MarqSpec.FuturesLiquidityDashboard.Api.Telemetry;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using Microsoft.AspNetCore.SignalR;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Hubs;

/// <summary>
/// Publishes each watched engine's delta on a fixed cadence (REQUIREMENTS.md NFR-2). An engine nobody watches only moves
/// its sequence on and builds nothing (REQUIREMENTS.md FR-54). While a snapshot is in flight, that connection's later deltas
/// are kept in order and sent when the snapshot finishes. The buffer holds one delta per tick across the catch-up
/// interval and <c>Api:PublishTimeoutMs</c>, fixed when the publisher starts. Past that they are discarded and one
/// more snapshot follows. A send in a flushed batch that fails stops the batch, and one snapshot is sent instead.
/// A send still running after
/// <c>Api:PublishTimeoutMs</c> aborts the connection, because cancelling the write does not remove a message SignalR
/// has already buffered (ARCHITECTURE.md D-32).
/// </summary>
public sealed partial class MarketPublisher(
    EngineRegistry registry,
    OverlayStore overlays,
    WatchTracker watches,
    IHubContext<MarketHub> hub,
    TimeProvider time,
    IConfiguration configuration,
    DashboardMetrics metrics,
    BrowserSendGate gate,
    ILogger<MarketPublisher> logger) : BackgroundService
{
    private readonly int _publishMs = Math.Clamp(configuration.GetValue("Api:PublishMs", 250), 50, 5_000);
    private readonly int _timeoutMs = Math.Clamp(configuration.GetValue("Api:PublishTimeoutMs", 1_000), 50, 30_000);
    private int _bufferReady;

    /// <summary>Publish and the snapshot flush share this so a newer delta cannot overtake a buffered one.</summary>
    private readonly Lock _dispatch = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        EnsureBuffer();
        var timeout = TimeSpan.FromMilliseconds(_timeoutMs);
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(_publishMs), time);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                await PublishOnceAsync(timeout, stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
    }

    /// <summary>One publication pass. Internal so a test can run it without the timer.</summary>
    internal Task PublishOnceAsync(TimeSpan timeout, CancellationToken stoppingToken)
    {
        lock (_dispatch)
        {
            EnsureBuffer();
            PublishLocked(timeout, stoppingToken);
        }

        return Task.CompletedTask;
    }

    private void EnsureBuffer()
    {
        if (Volatile.Read(ref _bufferReady) != 0)
        {
            return;
        }

        gate.BufferCapacity = BrowserSendGate.CapacityFor(_publishMs, _timeoutMs);
        Volatile.Write(ref _bufferReady, 1);
    }

    private void PublishLocked(TimeSpan timeout, CancellationToken stoppingToken)
    {
        var nowMs = time.GetUtcNow().ToUnixTimeMilliseconds();
        foreach (var engine in registry.All)
        {
            try
            {
                var root = engine.Spec.Root;
                var rootName = root.ToString();
                var subscribers = watches.SubscriberIds(root);
                var observed = new Dictionary<string, int>(subscribers.Count, StringComparer.Ordinal);
                foreach (var id in subscribers)
                {
                    observed[id] = gate.Observe(id);
                }

                // Ids recorded at the start of the tick. A later id is used only when it is still tracked:
                // Forget has removed a disconnected id, and this lookup must not create a generation for it.
                bool TryAt(string id, out int generation) =>
                    observed.TryGetValue(id, out generation) || gate.TryCurrent(id, out generation);

                var idle = subscribers.Where(id => TryAt(id, out var at) && gate.TryStartDelta(id, rootName, at)).ToList();
                var wantsSnapshot = subscribers.Where(id => gate.WantsSnapshot(id, rootName)).ToList();
                var buffering = subscribers.Where(id => gate.IsBuffering(id, rootName)).ToList();
                if (subscribers.Count > 0 && idle.Count == 0 && wantsSnapshot.Count == 0 && buffering.Count == 0)
                {
                    // Everyone is mid-send, or the connection was aborted. No delta was produced.
                    continue;
                }

                if (engine.PublishIfWatched(overlays.Current(root)) is not { } delta)
                {
                    continue;
                }

                var current = watches.SubscriberIds(root);
                var ready = current.Where(id => TryAt(id, out var at) && gate.TryStartDelta(id, rootName, at)).ToList();
                var skipped = 0;
                foreach (var id in current)
                {
                    if (!TryAt(id, out var at))
                    {
                        continue;
                    }

                    if (ready.Contains(id))
                    {
                        var send = hub.Clients.Client(id).SendAsync(
                            MarketHub.DeltaMethod, ForConnection(id, root, delta), stoppingToken);
                        Track(rootName, id, send, timeout, snapshot: false, at, stoppingToken);
                        continue;
                    }

                    var offered = gate.Offer(id, rootName, delta, at);
                    if (offered >= 0)
                    {
                        skipped += offered;
                        continue;
                    }

                    if (gate.NoteSkipped(id, rootName, at))
                    {
                        skipped++;
                    }
                }

                metrics.PublishSkipped(skipped);

                // The snapshot is built after this tick's delta, so it already includes it.
                foreach (var id in watches.SubscriberIds(root))
                {
                    if (TryAt(id, out var at) && gate.TryStartSnapshot(id, rootName, nowMs, BrowserSendGate.CatchUpIntervalMs, at))
                    {
                        SendSnapshot(engine, id, timeout, at, stoppingToken);
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Log.PublishFailed(logger, engine.Spec.Root.ToString(), ex);
            }
        }
    }

    private void SendSnapshot(InstrumentEngine engine, string connectionId, TimeSpan timeout, int observedAt, CancellationToken stoppingToken)
    {
        var rootName = engine.Spec.Root.ToString();
        try
        {
            var root = engine.Spec.Root;
            var snapshot = engine.Snapshot(watches.HistoryMinutes(connectionId, root), overlays.Current(root))
                .ForIndicatorMinutes(watches.IndicatorMinutes(connectionId, root));
            var send = hub.Clients.Client(connectionId).SendAsync(MarketHub.SnapshotMethod, snapshot, stoppingToken);
            Track(rootName, connectionId, send, timeout, snapshot: true, observedAt, stoppingToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.PublishFailed(logger, rootName, ex);
        }
    }

    private async Task SendBuffered(string connectionId, string rootName, IReadOnlyList<DashboardDelta> batch, CancellationToken stoppingToken)
    {
        var root = InstrumentRoot.Parse(rootName);
        foreach (var delta in batch)
        {
            try
            {
                var viewerDelta = ForConnection(connectionId, root, delta);
                await hub.Clients.Client(connectionId).SendAsync(MarketHub.DeltaMethod, viewerDelta, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                Log.PublishFailed(logger, rootName, ex);
                gate.FailFlush(connectionId, rootName);
                return;
            }
        }
    }

    /// <summary>
    /// The delta this connection should see. The buffer keeps the full publication so a timeframe change
    /// applies when the held deltas are sent; the sequence number is the publication's.
    /// </summary>
    private DashboardDelta ForConnection(string connectionId, InstrumentRoot root, DashboardDelta delta) =>
        delta.ForIndicatorMinutes(watches.IndicatorMinutes(connectionId, root));

    private void Track(string root, string connectionId, Task send, TimeSpan timeout, bool snapshot, int observedAt, CancellationToken stoppingToken)
    {
        metrics.PublishSendStarted();
        gate.Attach(connectionId, root, send, snapshot, observedAt);
        _ = Finish();

        async Task Finish()
        {
            try
            {
                await BrowserSendGate.WatchAsync(
                    gate,
                    connectionId,
                    root,
                    send,
                    time,
                    timeout,
                    () =>
                    {
                        metrics.PublishAborted();
                        gate.Abandon(connectionId, root);
                        watches.Abort(connectionId);
                    },
                    stoppingToken)
                    .ConfigureAwait(false);
            }
            finally
            {
                try
                {
                    var chained = false;
                    lock (_dispatch)
                    {
                        if ((snapshot || gate.IsBuffering(connectionId, root)) && gate.TryCurrent(connectionId, out var observed))
                        {
                            var batch = gate.TakeBuffered(connectionId, root);
                            if (batch.Count > 0)
                            {
                                var chain = SendBuffered(connectionId, root, batch, stoppingToken);
                                Track(root, connectionId, chain, timeout, snapshot: false, observed, stoppingToken);
                                chained = true;
                            }
                        }

                        if (!chained)
                        {
                            gate.Complete(connectionId, root);
                        }
                    }
                }
                finally
                {
                    metrics.PublishSendFinished();
                }
            }
        }
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Error, Message = "Publishing {Instrument} failed")]
        public static partial void PublishFailed(ILogger logger, string instrument, Exception exception);
    }
}
