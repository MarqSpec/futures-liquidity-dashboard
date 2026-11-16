using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using Microsoft.AspNetCore.SignalR;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Hubs;

/// <summary>The answer to <see cref="MarketHub.SetWatchlist"/>: the roots that get depth for this viewer, and the rest.</summary>
public sealed record WatchlistResult(IReadOnlyList<string> Depth, IReadOnlyList<string> Refused);

/// <summary>
/// What each hub connection watches (REQUIREMENTS.md FR-54): the products it subscribed to, whose engines then build deltas,
/// and its watchlist. Both want depth, so each connection holds one <see cref="DepthDemand"/> reference per product
/// in their union, and lets go of all of them when it disconnects. Subscribing again to a product already
/// subscribed (a client's resync after a gap) counts once. Thread-safe.
/// </summary>
public sealed class WatchTracker(EngineRegistry registry, DepthDemand depth, IConfiguration configuration)
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Connection> _connections = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HubCallerContext> _contexts = new(StringComparer.Ordinal);

    /// <summary>The most products one connection's watchlist may hold (<c>Api:MaxWatchlist</c>).</summary>
    public int MaxWatchlist { get; } = Math.Clamp(configuration?.GetValue("Api:MaxWatchlist", 12) ?? 12, 0, 50);

    /// <summary>Remembers the hub context so a stalled browser can be aborted (ARCHITECTURE.md D-32).</summary>
    public void Attach(HubCallerContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        lock (_gate)
        {
            _contexts[context.ConnectionId] = context;
        }
    }

    /// <summary>
    /// Drops the connection. SignalR has already copied any in-flight delta into the transport buffer, so the
    /// only way to stop a stalled browser growing that buffer is to abort it.
    /// </summary>
    public void Abort(string connectionId)
    {
        HubCallerContext? context;
        lock (_gate)
        {
            _contexts.TryGetValue(connectionId, out context);
        }

        context?.Abort();
    }

    /// <summary>
    /// Remembers the indicator timeframe for a later <see cref="Subscribe"/> and for deltas already streaming.
    /// 1, 5 or 15; any other value is one minute. The hub calls this before <see cref="Subscribe"/> because
    /// SignalR does not apply a C# default when the caller omits an argument.
    /// </summary>
    public void SetIndicatorMinutes(string connectionId, InstrumentRoot root, int indicatorMinutes)
    {
        lock (_gate)
        {
            Get(connectionId).IndicatorMinutes[root] = IndicatorPayloadExtensions.NormalizeIndicatorMinutes(indicatorMinutes);
        }
    }

    /// <summary>
    /// Starts (or, for a resync, re-reads) a viewer's stream of <paramref name="engine"/> and returns its snapshot.
    /// Indicators are the timeframe from <paramref name="indicatorMinutes"/> when it is set, otherwise the one
    /// <see cref="SetIndicatorMinutes"/> stored, otherwise one minute. Subscribing again does not count another viewer.
    /// </summary>
    public DashboardSnapshot Subscribe(
        string connectionId, InstrumentEngine engine, int historyMinutes, Overlay? overlay, int? indicatorMinutes = null)
    {
        ArgumentNullException.ThrowIfNull(engine);
        lock (_gate)
        {
            var connection = Get(connectionId);
            var root = engine.Spec.Root;
            connection.HistoryMinutes[root] = Math.Max(1, historyMinutes);
            var minutes = IndicatorPayloadExtensions.NormalizeIndicatorMinutes(
                indicatorMinutes ?? (connection.IndicatorMinutes.TryGetValue(root, out var stored)
                    ? stored
                    : IndicatorPayloadExtensions.DefaultMinutes));
            connection.IndicatorMinutes[root] = minutes;
            var before = connection.DepthRoots();
            if (!connection.Subscribed.Add(root))
            {
                return engine.Snapshot(historyMinutes, overlay).ForIndicatorMinutes(minutes);
            }

            var snapshot = engine.Watch(historyMinutes, overlay);
            Reconcile(before, connection.DepthRoots());
            return snapshot.ForIndicatorMinutes(minutes);
        }
    }

    public void Unsubscribe(string connectionId, InstrumentRoot root)
    {
        lock (_gate)
        {
            if (!_connections.TryGetValue(connectionId, out var connection) || !connection.Subscribed.Contains(root))
            {
                return;
            }

            var before = connection.DepthRoots();
            connection.Subscribed.Remove(root);
            connection.HistoryMinutes.Remove(root);
            connection.IndicatorMinutes.Remove(root);
            Unwatch(root);
            Reconcile(before, connection.DepthRoots());
        }
    }

    /// <summary>
    /// Replaces the connection's watchlist with the permitted, enabled roots among <paramref name="roots"/>, up to
    /// <see cref="MaxWatchlist"/>. Refused are the roots dropped and those past the server's depth limit.
    /// </summary>
    public WatchlistResult SetWatchlist(string connectionId, IEnumerable<InstrumentRoot> roots, Func<InstrumentRoot, bool> permitted)
    {
        ArgumentNullException.ThrowIfNull(roots);
        ArgumentNullException.ThrowIfNull(permitted);
        lock (_gate)
        {
            var connection = Get(connectionId);
            var refused = new List<InstrumentRoot>();
            var kept = new List<InstrumentRoot>();
            foreach (var root in roots.Distinct())
            {
                if (kept.Count < MaxWatchlist && registry.TryGet(root, out _) && permitted(root))
                {
                    kept.Add(root);
                }
                else
                {
                    refused.Add(root);
                }
            }

            var before = connection.DepthRoots();
            connection.Watchlist.Clear();
            connection.Watchlist.UnionWith(kept);
            Reconcile(before, connection.DepthRoots());

            var granted = depth.Wanted(registry.Enabled, out _);
            var withDepth = kept.Where(granted.Contains).ToList();
            refused.AddRange(kept.Where(r => !granted.Contains(r)));
            return new WatchlistResult(withDepth.Select(r => r.Value).ToList(), refused.Select(r => r.Value).ToList());
        }
    }

    /// <summary>Lets go of everything the connection held.</summary>
    public void Disconnect(string connectionId)
    {
        lock (_gate)
        {
            _contexts.Remove(connectionId);
            if (!_connections.Remove(connectionId, out var connection))
            {
                return;
            }

            foreach (var root in connection.Subscribed)
            {
                Unwatch(root);
            }

            Reconcile(connection.DepthRoots(), []);
        }
    }

    /// <summary>Indicator timeframe this connection asked for on <paramref name="root"/>, or one minute when it has not said.</summary>
    public int IndicatorMinutes(string connectionId, InstrumentRoot root)
    {
        lock (_gate)
        {
            return _connections.TryGetValue(connectionId, out var connection)
                && connection.IndicatorMinutes.TryGetValue(root, out var minutes)
                ? minutes
                : IndicatorPayloadExtensions.DefaultMinutes;
        }
    }

    /// <summary>History length this connection asked for when it subscribed to <paramref name="root"/>.</summary>
    public int HistoryMinutes(string connectionId, InstrumentRoot root)
    {
        lock (_gate)
        {
            return _connections.TryGetValue(connectionId, out var connection)
                && connection.HistoryMinutes.TryGetValue(root, out var minutes)
                ? minutes
                : 1;
        }
    }

    /// <summary>Connections currently subscribed to <paramref name="root"/>, for the publisher's per-browser sends.</summary>
    public IReadOnlyList<string> SubscriberIds(InstrumentRoot root)
    {
        lock (_gate)
        {
            return _connections.Where(pair => pair.Value.Subscribed.Contains(root)).Select(pair => pair.Key).ToList();
        }
    }

    /// <summary>Open connections, for tests and metrics.</summary>
    public int Connections
    {
        get
        {
            lock (_gate)
            {
                return _connections.Count;
            }
        }
    }

    private Connection Get(string connectionId)
    {
        if (!_connections.TryGetValue(connectionId, out var connection))
        {
            connection = new Connection();
            _connections[connectionId] = connection;
        }

        return connection;
    }

    private void Unwatch(InstrumentRoot root)
    {
        if (registry.TryGet(root, out var engine))
        {
            engine.Unwatch();
        }
    }

    private void Reconcile(HashSet<InstrumentRoot> before, HashSet<InstrumentRoot> after)
    {
        foreach (var root in after.Where(r => !before.Contains(r)))
        {
            depth.Acquire(root);
        }

        foreach (var root in before.Where(r => !after.Contains(r)))
        {
            depth.Release(root);
        }
    }

    private sealed class Connection
    {
        public HashSet<InstrumentRoot> Subscribed { get; } = [];

        public HashSet<InstrumentRoot> Watchlist { get; } = [];

        public Dictionary<InstrumentRoot, int> HistoryMinutes { get; } = [];

        public Dictionary<InstrumentRoot, int> IndicatorMinutes { get; } = [];

        public HashSet<InstrumentRoot> DepthRoots() => [.. Subscribed, .. Watchlist];
    }
}
