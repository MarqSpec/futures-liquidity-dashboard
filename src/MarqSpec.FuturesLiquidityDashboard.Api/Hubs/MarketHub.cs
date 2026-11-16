using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Hubs;

/// <summary>
/// The browser stream (INTERFACES.md Interface D.2). <see cref="Subscribe"/> joins the instrument's group and
/// returns a coherent snapshot; the server then sends <c>delta</c> messages every publication. A client buffers
/// deltas that arrive before the snapshot, drops those with <c>seq</c> at or below the snapshot's, and re-subscribes
/// when it sees a gap (REQUIREMENTS.md NFR-5). <see cref="SetIndicatorTimeframe"/> chooses which indicator series that
/// connection receives. Only subscribed products build deltas, and <see cref="SetWatchlist"/> says which
/// further products the viewer wants depth for (REQUIREMENTS.md FR-54). The hub has no method that trades (REQUIREMENTS.md FR-6).
/// </summary>
[Authorize]
public sealed class MarketHub(EngineRegistry registry, OverlayStore overlays, WatchTracker watches, BrowserSendGate gate) : Hub
{
    public const string Path = "/hubs/market";
    public const string DeltaMethod = "delta";

    /// <summary>One catch-up snapshot for a browser that missed deltas while its previous send was still running (D-32).</summary>
    public const string SnapshotMethod = "snapshot";

    public static string Group(InstrumentRoot root) => $"instrument:{root}";

    /// <summary>
    /// Remembers this connection's indicator timeframe for <paramref name="instrument"/> (1, 5 or 15; any other
    /// value is one minute). Call it before <see cref="Subscribe"/>, and again before a later subscribe when the
    /// viewer changes timeframe. It does not trade and does not join a group.
    /// </summary>
    public void SetIndicatorTimeframe(string instrument, int indicatorMinutes)
    {
        var root = Authorize(instrument);
        watches.Attach(Context);
        watches.SetIndicatorMinutes(Context.ConnectionId, root, indicatorMinutes);
    }

    public async Task<DashboardSnapshot> Subscribe(string instrument, int historyMinutes)
    {
        var root = Authorize(instrument);
        if (!registry.TryGet(root, out var engine))
        {
            throw new HubException($"Instrument {root} is not enabled.");
        }

        watches.Attach(Context);
        // Join first, so no delta published after the snapshot is missed; the client drops the older ones.
        await Groups.AddToGroupAsync(Context.ConnectionId, Group(root)).ConfigureAwait(false);
        return watches.Subscribe(Context.ConnectionId, engine, Math.Max(1, historyMinutes), overlays.Current(root));
    }

    public async Task Unsubscribe(string instrument)
    {
        var root = Authorize(instrument);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, Group(root)).ConfigureAwait(false);
        watches.Unsubscribe(Context.ConnectionId, root);
    }

    /// <summary>
    /// Replaces this viewer's watchlist (REQUIREMENTS.md FR-54, FR-55): the products it wants depth for besides the ones it
    /// subscribed to. Roots that are malformed, not enabled, not permitted, past <c>Api:MaxWatchlist</c> or past
    /// the server's depth limit come back as refused; those products still stream trades and quotes.
    /// </summary>
    public WatchlistResult SetWatchlist(string[] instruments)
    {
        ArgumentNullException.ThrowIfNull(instruments);
        var refused = new List<string>();
        var roots = new List<InstrumentRoot>();
        foreach (var value in instruments.Take(100))
        {
            if (InstrumentRoot.TryParse(value, out var root))
            {
                roots.Add(root);
            }
            else
            {
                refused.Add(value ?? string.Empty);
            }
        }

        var user = Context.User;
        var result = watches.SetWatchlist(
            Context.ConnectionId,
            roots,
            r => user is not null && Permissions.Has(user, Permissions.ViewDashboard, r));
        return refused.Count == 0 ? result : result with { Refused = [.. refused, .. result.Refused] };
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        // The watch goes first. Forget removes that connection's generation, so a tick that already read the
        // subscriber list cannot recreate the slot.
        watches.Disconnect(Context.ConnectionId);
        gate.Forget(Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    private InstrumentRoot Authorize(string instrument)
    {
        if (!InstrumentRoot.TryParse(instrument, out var root))
        {
            throw new HubException($"Unknown instrument '{instrument}'.");
        }

        if (Context.User is null || !Permissions.Has(Context.User, Permissions.ViewDashboard, root))
        {
            throw new HubException($"No view-dashboard permission for {root}.");
        }

        return root;
    }
}
