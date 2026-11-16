using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;

public enum FlowKind
{
    /// <summary>Resting quantity added.</summary>
    Added,

    /// <summary>Resting quantity removed without trading (cancelled or pulled).</summary>
    Pulled,

    /// <summary>Resting quantity removed by executions against it.</summary>
    Filled,
}

/// <summary>Liquidity flow over a window, in contracts, by side of the resting order.</summary>
public sealed record FlowTotals(long BidAdded, long BidPulled, long BidFilled, long AskAdded, long AskPulled, long AskFilled)
{
    public long NetBid => BidAdded - BidPulled - BidFilled;

    public long NetAsk => AskAdded - AskPulled - AskFilled;
}

/// <summary>
/// Classifies every change of resting quantity as added, pulled or filled. A decrease is first matched against
/// executions just seen at that price on that side (a fill); the remainder is a pull. Keeps a bounded rolling
/// window of flows (REQUIREMENTS.md NFR-4).
/// </summary>
public sealed class LiquidityFlowTracker(long windowMs = 60_000, long fillMatchMs = 2_000)
{
    private readonly Queue<(long TimeMs, BookSide Side, FlowKind Kind, long Quantity)> _flows = new();
    private readonly Dictionary<(BookSide Side, long Price), (long Quantity, long TimeMs)> _pendingFills = [];

    /// <summary>Records an execution: the aggressor consumed liquidity resting on the opposite side.</summary>
    public void OnTrade(long timeMs, TradeEvent trade)
    {
        ArgumentNullException.ThrowIfNull(trade);
        var resting = trade.Aggressor == BookSide.Bid ? BookSide.Ask : BookSide.Bid;
        var key = (resting, trade.PriceTicks);
        var pending = _pendingFills.GetValueOrDefault(key);
        _pendingFills[key] = (pending.Quantity + trade.Quantity, timeMs);
    }

    public void OnLevelChange(long timeMs, LevelChange change)
    {
        if (change.Delta > 0)
        {
            Record(timeMs, change.Side, FlowKind.Added, change.Delta);
            return;
        }

        var removed = -change.Delta;
        var key = (change.Side, change.PriceTicks);
        if (_pendingFills.TryGetValue(key, out var pending) && timeMs - pending.TimeMs <= fillMatchMs)
        {
            var filled = Math.Min(removed, pending.Quantity);
            Record(timeMs, change.Side, FlowKind.Filled, filled);
            removed -= filled;
            if (pending.Quantity - filled <= 0)
            {
                _pendingFills.Remove(key);
            }
            else
            {
                _pendingFills[key] = (pending.Quantity - filled, pending.TimeMs);
            }
        }

        if (removed > 0)
        {
            Record(timeMs, change.Side, FlowKind.Pulled, removed);
        }
    }

    public FlowTotals Totals(long nowMs, long windowMsOverride)
    {
        Expire(nowMs);
        long ba = 0, bp = 0, bf = 0, aa = 0, ap = 0, af = 0;
        foreach (var f in _flows.Where(f => f.TimeMs > nowMs - windowMsOverride))
        {
            switch (f.Side, f.Kind)
            {
                case (BookSide.Bid, FlowKind.Added): ba += f.Quantity; break;
                case (BookSide.Bid, FlowKind.Pulled): bp += f.Quantity; break;
                case (BookSide.Bid, FlowKind.Filled): bf += f.Quantity; break;
                case (BookSide.Ask, FlowKind.Added): aa += f.Quantity; break;
                case (BookSide.Ask, FlowKind.Pulled): ap += f.Quantity; break;
                case (BookSide.Ask, FlowKind.Filled): af += f.Quantity; break;
                default: throw new InvalidOperationException("Unknown flow.");
            }
        }

        return new FlowTotals(ba, bp, bf, aa, ap, af);
    }

    /// <summary>Forgets pending fills and flows across a book reset, so a new baseline is never read as adds.</summary>
    public void Reset() => _pendingFills.Clear();

    private void Record(long timeMs, BookSide side, FlowKind kind, long quantity) =>
        _flows.Enqueue((timeMs, side, kind, quantity));

    private void Expire(long nowMs)
    {
        while (_flows.Count > 0 && _flows.Peek().TimeMs <= nowMs - windowMs)
        {
            _flows.Dequeue();
        }

        foreach (var key in _pendingFills.Where(p => nowMs - p.Value.TimeMs > fillMatchMs).Select(p => p.Key).ToList())
        {
            _pendingFills.Remove(key);
        }
    }
}
