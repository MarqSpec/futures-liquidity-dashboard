using System.Threading.Channels;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

/// <summary>Why a contract left the normal path (ARCHITECTURE.md D-32).</summary>
public enum IngestRecoveryKind
{
    /// <summary>The pending depth book passed its price cap and must be snapshotted again.</summary>
    Depth,

    /// <summary>A trade did not fit in that contract's queue. The contract is marked missing from this time.</summary>
    Trades,
}

/// <summary>
/// One contract the reader should mark missing. <see cref="GapStartMs"/> is the first dropped trade's source time.
/// <see cref="GapThroughMs"/> is the latest, so a burst is not recorded as a one-millisecond hole.
/// </summary>
public readonly record struct IngestRecovery(InstrumentRoot Root, IngestRecoveryKind Kind, long GapStartMs, long GapThroughMs = 0);

/// <summary>
/// The bounded hand-off between a market-hub callback and the single reader (ARCHITECTURE.md D-32, REQUIREMENTS.md NFR-4).
/// Each contract has its own trade queue, so one product's burst cannot push the others off LIVE. A trade that
/// does not fit is counted and marked missing at once: the callback never waits, because the ProjectX client raises
/// <c>HandleGatewayTrade</c> on the SignalR receive loop and a wait there would stall every other event.
/// Quotes keep the latest per contract. Depth keeps the latest absolute size per price. A disconnect drops that
/// contract's pending depth and is not forgotten when a connect arrives first.
/// </summary>
public sealed class MarketIngestBuffer : IDisposable
{
    private readonly object _gate = new();
    private readonly IngestBufferOptions _options;
    private readonly IngestMetrics? _metrics;
    private readonly Dictionary<InstrumentRoot, Queue<TradeEvent>> _trades = [];
    private readonly Dictionary<InstrumentRoot, long> _gapStartMs = [];
    private readonly Dictionary<InstrumentRoot, long> _gapThroughMs = [];
    private readonly Dictionary<InstrumentRoot, QuoteEvent> _quotes = [];
    private readonly Dictionary<InstrumentRoot, DepthSlot> _depth = [];
    private readonly Dictionary<InstrumentRoot, ControlSlot> _control = [];
    private readonly HashSet<InstrumentRoot> _depthOverflow = [];
    private readonly Channel<int> _wake = Channel.CreateBounded<int>(new BoundedChannelOptions(1)
    {
        SingleReader = true,
        SingleWriter = false,
        FullMode = BoundedChannelFullMode.DropWrite,
    });

    private long _coalesced;
    private long _droppedTrades;
    private long _depthDiscarded;
    private long _recoveries;
    private bool _completed;

    public MarketIngestBuffer(IngestBufferOptions options, IngestMetrics? metrics = null)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        ArgumentOutOfRangeException.ThrowIfLessThan(options.TradeCapacity, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(options.DepthLevelsPerContract, 1);
        _metrics = metrics;
        PublishGauges();
    }

    public int TradeCapacity => _options.TradeCapacity;

    /// <summary>Trades waiting across every contract.</summary>
    public int QueuedTradeCount
    {
        get
        {
            lock (_gate)
            {
                return _trades.Values.Sum(queue => queue.Count);
            }
        }
    }

    /// <summary>Trades waiting for one contract.</summary>
    public int QueuedTrades(InstrumentRoot root)
    {
        lock (_gate)
        {
            return _trades.TryGetValue(root, out var queue) ? queue.Count : 0;
        }
    }

    public int QueuedQuoteCount
    {
        get
        {
            lock (_gate)
            {
                return _quotes.Count;
            }
        }
    }

    public int QueuedDepthCount
    {
        get
        {
            lock (_gate)
            {
                return DepthCount();
            }
        }
    }

    public long Coalesced
    {
        get
        {
            lock (_gate)
            {
                return _coalesced;
            }
        }
    }

    public long DroppedTrades
    {
        get
        {
            lock (_gate)
            {
                return _droppedTrades;
            }
        }
    }

    public long DepthDiscarded
    {
        get
        {
            lock (_gate)
            {
                return _depthDiscarded;
            }
        }
    }

    public long Recoveries
    {
        get
        {
            lock (_gate)
            {
                return _recoveries;
            }
        }
    }

    /// <summary>Hands <paramref name="marketEvent"/> to the reader. Returns as soon as the event is stored or counted.</summary>
    public void Submit(MarketEvent marketEvent, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(marketEvent);
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_completed)
            {
                return;
            }

            switch (marketEvent)
            {
                case TradeEvent trade:
                    SubmitTrade(trade);
                    break;
                case QuoteEvent quote:
                    CoalesceQuote(quote);
                    break;
                case DepthUpdateEvent update:
                    CoalesceDepth(update);
                    break;
                case DepthSnapshotEvent snapshot:
                    CoalesceSnapshot(snapshot);
                    break;
                case BookResetEvent reset:
                    CoalesceReset(reset);
                    break;
                case FeedStatusEvent status:
                    CoalesceStatus(status);
                    break;
                default:
                    return;
            }

            PublishGauges();
        }

        Signal();
    }

    /// <summary>Wakes the reader without storing an event. Used when the stream must stop for a session conflict.</summary>
    public void Wake() => Signal();

    /// <summary>Waits until <see cref="Submit"/> has stored something, or the buffer is <see cref="Complete"/>d.</summary>
    public ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken) =>
        _wake.Reader.WaitToReadAsync(cancellationToken);

    /// <summary>Clears the wake signal. Call it on the reader after <see cref="WaitToReadAsync"/> returns true.</summary>
    public void ConsumeWake()
    {
        while (_wake.Reader.TryRead(out _))
        {
        }
    }

    /// <summary>
    /// Contracts that overflowed since the last call. A contract with both a trade drop and a depth overflow is
    /// reported once, as <see cref="IngestRecoveryKind.Trades"/>.
    /// </summary>
    public IReadOnlyList<IngestRecovery> TakeRecoveries()
    {
        lock (_gate)
        {
            if (_depthOverflow.Count == 0 && _gapStartMs.Count == 0)
            {
                return [];
            }

            var byRoot = new Dictionary<InstrumentRoot, IngestRecovery>();
            foreach (var root in _depthOverflow)
            {
                byRoot[root] = new IngestRecovery(root, IngestRecoveryKind.Depth, 0);
            }

            foreach (var (root, gapStart) in _gapStartMs)
            {
                var through = _gapThroughMs.GetValueOrDefault(root, gapStart);
                if (through < gapStart)
                {
                    through = gapStart;
                }

                byRoot[root] = new IngestRecovery(root, IngestRecoveryKind.Trades, gapStart, through);
            }

            _depthOverflow.Clear();
            _gapStartMs.Clear();
            _gapThroughMs.Clear();
            return byRoot.Values.ToList();
        }
    }

    /// <summary>Drops one contract's pending depth so a reset is not followed by a stale book. Returns how many rows went.</summary>
    public long DiscardDepth(InstrumentRoot root)
    {
        lock (_gate)
        {
            var discarded = ClearDepth(root);
            PublishGauges();
            return discarded;
        }
    }

    /// <summary>Everything waiting, in sequence order, so a disconnect is not applied before the trades that preceded it.</summary>
    public IReadOnlyList<MarketEvent> Drain()
    {
        List<MarketEvent> batch;
        lock (_gate)
        {
            batch = [];
            foreach (var queue in _trades.Values)
            {
                while (queue.TryDequeue(out var trade))
                {
                    batch.Add(trade);
                }
            }

            foreach (var quote in _quotes.Values)
            {
                batch.Add(quote);
            }

            _quotes.Clear();
            foreach (var slot in _depth.Values)
            {
                if (slot.Snapshot is not null)
                {
                    batch.Add(slot.Snapshot);
                }

                foreach (var level in slot.Levels.Values)
                {
                    batch.Add(level);
                }
            }

            _depth.Clear();
            foreach (var slot in _control.Values)
            {
                if (slot.Disconnect is not null)
                {
                    batch.Add(slot.Disconnect);
                }

                if (slot.Status is not null)
                {
                    batch.Add(slot.Status);
                }

                if (slot.Reset is not null)
                {
                    batch.Add(slot.Reset);
                }
            }

            _control.Clear();
            PublishGauges();
        }

        batch.Sort(static (a, b) => a.Sequence.CompareTo(b.Sequence));
        return batch;
    }

    /// <summary>Stops the reader. Further submits are ignored.</summary>
    public void Complete()
    {
        lock (_gate)
        {
            _completed = true;
            _trades.Clear();
            _quotes.Clear();
            _depth.Clear();
            _control.Clear();
            PublishGauges();
        }

        _wake.Writer.TryComplete();
    }

    public void Dispose()
    {
    }

    private void SubmitTrade(TradeEvent trade)
    {
        var queue = Trades(trade.Root);
        if (queue.Count >= _options.TradeCapacity)
        {
            _droppedTrades++;
            _metrics?.AddDroppedTrades(1);
            var stamp = InstrumentEngine.AcceptedStamp(trade.SourceTimeMs, trade.ReceivedTimeMs);
            if (_gapStartMs.TryAdd(trade.Root, stamp))
            {
                _recoveries++;
                _metrics?.AddRecovery("trades");
            }

            if (!_gapThroughMs.TryGetValue(trade.Root, out var through) || stamp > through)
            {
                _gapThroughMs[trade.Root] = stamp;
            }

            return;
        }

        queue.Enqueue(trade);
    }

    private void CoalesceQuote(QuoteEvent quote)
    {
        if (_quotes.ContainsKey(quote.Root))
        {
            NoteCoalesced("quote", 1);
        }

        _quotes[quote.Root] = quote;
    }

    private void CoalesceDepth(DepthUpdateEvent update)
    {
        if (_depthOverflow.Contains(update.Root))
        {
            NoteDiscarded(1);
            return;
        }

        var slot = Depth(update.Root);
        var key = (update.Side, update.PriceTicks);
        if (slot.Levels.ContainsKey(key))
        {
            NoteCoalesced("depth", 1);
            slot.Levels[key] = update;
            return;
        }

        if (slot.Levels.Count >= _options.DepthLevelsPerContract)
        {
            var discarded = slot.Levels.Count + (slot.Snapshot is null ? 0 : 1);
            slot.Levels.Clear();
            slot.Snapshot = null;
            NoteDiscarded(discarded + 1);
            if (_depthOverflow.Add(update.Root))
            {
                _recoveries++;
                _metrics?.AddRecovery("depth");
            }

            return;
        }

        slot.Levels[key] = update;
    }

    private void CoalesceSnapshot(DepthSnapshotEvent snapshot)
    {
        var slot = Depth(snapshot.Root);
        var replaced = slot.Levels.Count + (slot.Snapshot is null ? 0 : 1);
        if (replaced > 0)
        {
            NoteCoalesced("depth", replaced);
        }

        slot.Levels.Clear();
        slot.Snapshot = snapshot;
        _depthOverflow.Remove(snapshot.Root);
    }

    private void CoalesceReset(BookResetEvent reset)
    {
        var slot = Control(reset.Root);
        if (slot.Reset is not null)
        {
            NoteCoalesced("control", 1);
        }

        slot.Reset = reset;
        ClearDepth(reset.Root);
        _depthOverflow.Remove(reset.Root);
    }

    private void CoalesceStatus(FeedStatusEvent status)
    {
        var slot = Control(status.Root);
        if (!status.Connected)
        {
            if (slot.Disconnect is not null)
            {
                NoteCoalesced("control", 1);
            }

            slot.Disconnect = status;
            ClearDepth(status.Root);
            return;
        }

        if (slot.Status is not null)
        {
            NoteCoalesced("control", 1);
        }

        slot.Status = status;
    }

    private long ClearDepth(InstrumentRoot root)
    {
        if (!_depth.Remove(root, out var slot))
        {
            return 0;
        }

        var discarded = slot.Levels.Count + (slot.Snapshot is null ? 0 : 1);
        NoteDiscarded(discarded);
        return discarded;
    }

    private void NoteCoalesced(string lane, long count)
    {
        if (count <= 0)
        {
            return;
        }

        _coalesced += count;
        _metrics?.AddCoalesced(lane, count);
    }

    private void NoteDiscarded(long count)
    {
        if (count <= 0)
        {
            return;
        }

        _depthDiscarded += count;
        _metrics?.AddDepthDiscarded(count);
    }

    private Queue<TradeEvent> Trades(InstrumentRoot root)
    {
        if (!_trades.TryGetValue(root, out var queue))
        {
            queue = new Queue<TradeEvent>();
            _trades[root] = queue;
        }

        return queue;
    }

    private DepthSlot Depth(InstrumentRoot root)
    {
        if (!_depth.TryGetValue(root, out var slot))
        {
            slot = new DepthSlot();
            _depth[root] = slot;
        }

        return slot;
    }

    private ControlSlot Control(InstrumentRoot root)
    {
        if (!_control.TryGetValue(root, out var slot))
        {
            slot = new ControlSlot();
            _control[root] = slot;
        }

        return slot;
    }

    private int DepthCount()
    {
        var count = 0;
        foreach (var slot in _depth.Values)
        {
            count += slot.Levels.Count + (slot.Snapshot is null ? 0 : 1);
        }

        return count;
    }

    private void PublishGauges() =>
        _metrics?.SetDepths(QueuedTradeCountUnlocked(), _quotes.Count, DepthCount(), _control.Count);

    private int QueuedTradeCountUnlocked() => _trades.Values.Sum(queue => queue.Count);

    private void Signal() => _wake.Writer.TryWrite(0);

    private sealed class DepthSlot
    {
        public DepthSnapshotEvent? Snapshot { get; set; }

        public Dictionary<(BookSide Side, long Price), DepthUpdateEvent> Levels { get; } = [];
    }

    private sealed class ControlSlot
    {
        public FeedStatusEvent? Disconnect { get; set; }

        public FeedStatusEvent? Status { get; set; }

        public BookResetEvent? Reset { get; set; }
    }
}
