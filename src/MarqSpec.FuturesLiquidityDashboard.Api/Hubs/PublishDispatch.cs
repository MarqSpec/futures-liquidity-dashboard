using MarqSpec.FuturesLiquidityDashboard.Core.Engine;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Hubs;

/// <summary>
/// Which browsers can take a delta, and when a slow one should get a snapshot instead of a gapped delta
/// (ARCHITECTURE.md D-32). Keyed by connection and instrument, so one instrument's send does not skip another.
/// A send that is still running after <c>Api:PublishTimeoutMs</c> aborts the connection: cancelling it does not
/// remove a message SignalR has already buffered. Deltas that arrive while a snapshot is in flight are buffered
/// and sent, in order, when that snapshot finishes.
/// </summary>
public sealed class BrowserSendGate
{
    private readonly Dictionary<Key, Slot> _slots = [];
    private readonly Dictionary<string, int> _generation = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private int _nextGeneration;

    /// <summary>How long a catch-up snapshot waits before another may be sent (D-32).</summary>
    public const int CatchUpIntervalMs = 2_000;

    /// <summary>
    /// Deltas held behind one snapshot: one per tick across the longer of <see cref="CatchUpIntervalMs"/> and
    /// <paramref name="publishTimeoutMs"/>, so a send that runs for the whole timeout does not overflow the buffer.
    /// </summary>
    public static int CapacityFor(int publishMs, int publishTimeoutMs = 1_000)
    {
        var period = Math.Clamp(publishMs, 50, 5_000);
        var timeout = Math.Clamp(publishTimeoutMs, 50, 30_000);
        return Math.Max(1, Math.Max(CatchUpIntervalMs, timeout) / period);
    }

    /// <summary>
    /// Set once from <c>Api:PublishMs</c> and <c>Api:PublishTimeoutMs</c>. The default is the 250 ms tick and the 1 s timeout.
    /// </summary>
    public int BufferCapacity { get; set; } = CapacityFor(250);

    /// <summary>Connections whose generation is still held. A disconnect removes its id.</summary>
    internal int TrackedConnections
    {
        get
        {
            lock (_gate)
            {
                return _generation.Count;
            }
        }
    }

    /// <summary>The generation a tick must pass back so a disconnect cannot be undone by a later slot lookup.</summary>
    public int Observe(string connectionId)
    {
        lock (_gate)
        {
            if (!_generation.TryGetValue(connectionId, out var generation))
            {
                generation = ++_nextGeneration;
                _generation[connectionId] = generation;
            }

            return generation;
        }
    }

    /// <summary>The generation of a connection that is still tracked. False after <see cref="Forget"/>.</summary>
    internal bool TryCurrent(string connectionId, out int generation)
    {
        lock (_gate)
        {
            return _generation.TryGetValue(connectionId, out generation);
        }
    }

    /// <summary>True when a delta may be started. A running send, a held snapshot, or a pending snapshot blocks it.</summary>
    public bool TryStartDelta(string connectionId, string root, int observedAt)
    {
        lock (_gate)
        {
            if (Stale(connectionId, observedAt))
            {
                return false;
            }

            var slot = SlotFor(connectionId, root);
            return !slot.Abandoned && !slot.Holding && slot.Send is not { IsCompleted: false } && !slot.NeedsSnapshot;
        }
    }

    /// <summary>True while this connection should keep deltas instead of skipping them (a snapshot is in flight or about to flush).</summary>
    public bool IsBuffering(string connectionId, string root)
    {
        lock (_gate)
        {
            return _slots.TryGetValue(new Key(connectionId, root), out var slot)
                && slot.Holding
                && !slot.Overflowed
                && !slot.Abandoned;
        }
    }

    /// <summary>
    /// Keeps <paramref name="delta"/> behind the in-flight snapshot. Returns 0 when it was kept, the number discarded
    /// when the cap overflowed, and -1 when this connection is not buffering.
    /// </summary>
    public int Offer(string connectionId, string root, DashboardDelta delta, int observedAt)
    {
        ArgumentNullException.ThrowIfNull(delta);
        lock (_gate)
        {
            if (Stale(connectionId, observedAt))
            {
                return -1;
            }

            var slot = SlotFor(connectionId, root);
            if (!slot.Holding || slot.Overflowed || slot.Abandoned)
            {
                return -1;
            }

            if (slot.Buffer.Count >= BufferCapacity)
            {
                var dropped = slot.Buffer.Count + 1;
                slot.Buffer.Clear();
                slot.Overflowed = true;
                slot.Missed = true;
                return dropped;
            }

            slot.Buffer.Enqueue(delta);
            return 0;
        }
    }

    /// <summary>The deltas to send now that the snapshot has finished, in the order they were published.</summary>
    public List<DashboardDelta> TakeBuffered(string connectionId, string root)
    {
        lock (_gate)
        {
            if (!_slots.TryGetValue(new Key(connectionId, root), out var slot) || slot.Abandoned || slot.Overflowed)
            {
                slot?.Buffer.Clear();
                return [];
            }

            var batch = slot.Buffer.ToList();
            slot.Buffer.Clear();
            return batch;
        }
    }

    /// <summary>Completes the next time this connection's send is released.</summary>
    internal Task WhenSettled(string connectionId, string root)
    {
        lock (_gate)
        {
            return _slots.TryGetValue(new Key(connectionId, root), out var slot)
                ? slot.Settled.Task
                : Task.CompletedTask;
        }
    }

    public void Attach(string connectionId, string root, Task send, bool snapshot, int observedAt)
    {
        ArgumentNullException.ThrowIfNull(send);
        lock (_gate)
        {
            if (Stale(connectionId, observedAt))
            {
                return;
            }

            var slot = SlotFor(connectionId, root);
            slot.Send = send;
            slot.Snapshot = snapshot;
        }
    }

    public bool InFlight(string connectionId, string root)
    {
        lock (_gate)
        {
            return _slots.TryGetValue(new Key(connectionId, root), out var slot) && slot.Send is { IsCompleted: false };
        }
    }

    public bool IsSendingSnapshot(string connectionId, string root)
    {
        lock (_gate)
        {
            return _slots.TryGetValue(new Key(connectionId, root), out var slot)
                && slot.Snapshot
                && slot.Send is { IsCompleted: false };
        }
    }

    public bool WantsSnapshot(string connectionId, string root)
    {
        lock (_gate)
        {
            return _slots.TryGetValue(new Key(connectionId, root), out var slot)
                && slot.NeedsSnapshot
                && !slot.Abandoned
                && slot.Send is not { IsCompleted: false };
        }
    }

    /// <summary>True when this connection still has a slot. Does not create one.</summary>
    public bool HasSlot(string connectionId, string root)
    {
        lock (_gate)
        {
            return _slots.ContainsKey(new Key(connectionId, root));
        }
    }

    /// <summary>Drops every slot for a connection that has gone away (ARCHITECTURE.md D-32, NFR-4).</summary>
    public void Forget(string connectionId)
    {
        lock (_gate)
        {
            // A missing id is stale, so a disconnected id does not stay for the life of the process.
            _generation.Remove(connectionId);
            foreach (var key in _slots.Keys.Where(key => key.ConnectionId == connectionId).ToList())
            {
                _slots.Remove(key);
            }
        }
    }

    /// <summary>The browser missed a delta while its send was still running.</summary>
    public void MarkMissed(string connectionId, string root, int observedAt)
    {
        lock (_gate)
        {
            if (Stale(connectionId, observedAt))
            {
                return;
            }

            SlotFor(connectionId, root).Missed = true;
        }
    }

    /// <summary>
    /// The browser did not take this delta. Returns true when that skip should be counted. A snapshot still in
    /// flight is buffered by <see cref="Offer"/> instead; an overflow of that buffer leaves one later snapshot.
    /// </summary>
    public bool NoteSkipped(string connectionId, string root, int observedAt)
    {
        lock (_gate)
        {
            if (Stale(connectionId, observedAt))
            {
                return false;
            }

            var slot = SlotFor(connectionId, root);
            if (slot.Abandoned)
            {
                return false;
            }

            // A follow-up already in flight keeps its own buffer. Overflow discards that buffer and leaves Missed set.
            if (slot.FollowUp || slot.NeedsSnapshot || slot.Holding)
            {
                return true;
            }

            if (slot.Send is { IsCompleted: false })
            {
                slot.Missed = true;
            }
            else
            {
                // The send finished between the idle check and here. Queue the one follow-up now.
                slot.NeedsSnapshot = true;
                slot.Missed = false;
            }

            return true;
        }
    }

    /// <summary>The connection was aborted. Do not send it another delta or a catch-up snapshot.</summary>
    public void Abandon(string connectionId, string root)
    {
        lock (_gate)
        {
            if (!_slots.TryGetValue(new Key(connectionId, root), out var slot))
            {
                return;
            }

            slot.Abandoned = true;
            slot.Holding = false;
            slot.Buffer.Clear();
            slot.Missed = false;
            slot.NeedsSnapshot = false;
            slot.Overflowed = false;
        }
    }

    public void Complete(string connectionId, string root)
    {
        lock (_gate)
        {
            if (!_slots.TryGetValue(new Key(connectionId, root), out var slot))
            {
                return;
            }

            if (slot.Abandoned)
            {
                slot.Send = null;
                slot.Holding = false;
                slot.NeedsSnapshot = false;
                Signal(slot);
                return;
            }

            // Missed is cleared when the snapshot starts, so it is set here only by an overflow or by a skipped
            // delta whose send was not a snapshot. Either one needs exactly one more snapshot.
            var catchUp = slot.Missed;
            slot.Send = null;
            slot.Snapshot = false;
            slot.FollowUp = false;
            slot.Holding = false;
            slot.Missed = false;
            slot.Overflowed = false;
            if (catchUp)
            {
                slot.NeedsSnapshot = true;
            }

            Signal(slot);
        }
    }

    private static void Signal(Slot slot)
    {
        var waiter = slot.Settled;
        slot.Settled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        waiter.TrySetResult();
    }

    /// <summary>
    /// A flushed delta failed. Drop the rest of that batch and ask for one snapshot now, without waiting out
    /// <see cref="CatchUpIntervalMs"/>.
    /// </summary>
    public void FailFlush(string connectionId, string root)
    {
        lock (_gate)
        {
            if (!_slots.TryGetValue(new Key(connectionId, root), out var slot) || slot.Abandoned)
            {
                return;
            }

            slot.Buffer.Clear();
            slot.Holding = false;
            slot.Overflowed = false;
            slot.Missed = true;
            slot.NeedsSnapshot = true;
            slot.LastSnapshotMs = null;
        }
    }

    /// <summary>True when this browser should be sent one snapshot now. Rate-limited by <paramref name="minIntervalMs"/>.</summary>
    public bool TryStartSnapshot(string connectionId, string root, long nowMs, long minIntervalMs, int observedAt)
    {
        lock (_gate)
        {
            if (Stale(connectionId, observedAt))
            {
                return false;
            }

            var slot = SlotFor(connectionId, root);
            if (!slot.NeedsSnapshot || slot.Send is { IsCompleted: false })
            {
                return false;
            }

            if (slot.LastSnapshotMs is { } last && nowMs - last < minIntervalMs)
            {
                return false;
            }

            slot.NeedsSnapshot = false;
            slot.Missed = false;
            slot.Overflowed = false;
            slot.FollowUp = true;
            slot.Holding = true;
            slot.Buffer.Clear();
            slot.LastSnapshotMs = nowMs;
            return true;
        }
    }

    public static async Task WatchAsync(
        BrowserSendGate gate,
        string connectionId,
        string root,
        Task send,
        TimeProvider time,
        TimeSpan timeout,
        Action onPaused,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(gate);
        ArgumentNullException.ThrowIfNull(send);
        ArgumentNullException.ThrowIfNull(time);
        ArgumentNullException.ThrowIfNull(onPaused);
        var delay = Task.Delay(timeout, time, cancellationToken);
        var finished = await Task.WhenAny(send, delay).ConfigureAwait(false);
        if (!ReferenceEquals(finished, send) && !send.IsCompleted)
        {
            onPaused();
        }

        try
        {
            await send.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Shutting down.
        }
        catch (Exception)
        {
            // The publisher logs the send itself. The slot still has to be released.
        }
    }

    private bool Stale(string connectionId, int observedAt) =>
        !_generation.TryGetValue(connectionId, out var generation) || generation != observedAt;

    private Slot SlotFor(string connectionId, string root)
    {
        var key = new Key(connectionId, root);
        if (!_slots.TryGetValue(key, out var slot))
        {
            slot = new Slot();
            _slots[key] = slot;
        }

        return slot;
    }

    private readonly record struct Key(string ConnectionId, string Root);

    private sealed class Slot
    {
        public Task? Send { get; set; }

        public bool Snapshot { get; set; }

        public bool Missed { get; set; }

        public bool NeedsSnapshot { get; set; }

        /// <summary>The snapshot now in flight is the one catch-up. Further deltas are buffered until it finishes.</summary>
        public bool FollowUp { get; set; }

        /// <summary>Deltas stay buffered from the moment the snapshot is accepted until they are flushed.</summary>
        public bool Holding { get; set; }

        /// <summary>The buffer overflowed. It was discarded, and one more snapshot will cover the hole.</summary>
        public bool Overflowed { get; set; }

        public bool Abandoned { get; set; }

        public long? LastSnapshotMs { get; set; }

        public Queue<DashboardDelta> Buffer { get; } = new();

        public TaskCompletionSource Settled { get; set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
