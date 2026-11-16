using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Book;

/// <summary>What happened to resting quantity at one price when an update was applied.</summary>
public readonly record struct LevelChange(BookSide Side, long PriceTicks, long PreviousQuantity, long Quantity)
{
    public long Delta => Quantity - PreviousQuantity;
}

/// <summary>
/// Aggregated price-level book for one contract on integer tick keys (ARCHITECTURE.md, Order book).
/// The book is unknown until a snapshot arrives and after any reset; only the top <see cref="LevelsPerSide"/>
/// levels on each side are covered, and a price outside that range is unknown, never zero (REQUIREMENTS.md FR-11).
/// Not thread-safe: one engine owns it.
/// </summary>
public sealed class OrderBook
{
    private readonly SortedDictionary<long, long> _bids = new(Comparer<long>.Create((a, b) => b.CompareTo(a)));
    private readonly SortedDictionary<long, long> _asks = new();

    // Ticks that came back into coverage after their data was trimmed: unknown until the feed updates them. Kept per
    // side, so a marker on one side never hides the other side's known size at the same price.
    private readonly HashSet<long> _unknownBids = [];
    private readonly HashSet<long> _unknownAsks = [];

    // The covered bound a side had when it emptied: on refill, every tick beyond it is newly covered and unknown.
    private long? _emptiedBidLow;
    private long? _emptiedAskHigh;

    public bool IsKnown { get; private set; }

    public int LevelsPerSide { get; private set; }

    /// <summary>Updates received while the book was unknown; they are dropped, never applied.</summary>
    public long DroppedWhileUnknown { get; private set; }

    public long? BestBid => IsKnown && _bids.Count > 0 ? _bids.Keys.First() : null;

    public long? BestAsk => IsKnown && _asks.Count > 0 ? _asks.Keys.First() : null;

    /// <summary>The lowest known price: the deepest covered bid tick.</summary>
    public long? CoveredLow => BestBid is { } bid ? bid - (LevelsPerSide - 1) : null;

    /// <summary>The highest known price: the deepest covered ask tick.</summary>
    public long? CoveredHigh => BestAsk is { } ask ? ask + (LevelsPerSide - 1) : null;

    public IEnumerable<KeyValuePair<long, long>> Bids => _bids;

    public IEnumerable<KeyValuePair<long, long>> Asks => _asks;

    /// <summary>Replaces the book with a baseline and makes it known.</summary>
    public void ApplySnapshot(DepthSnapshotEvent snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentOutOfRangeException.ThrowIfLessThan(snapshot.LevelsPerSide, 1);
        _bids.Clear();
        _asks.Clear();
        _unknownBids.Clear();
        _unknownAsks.Clear();
        (_emptiedBidLow, _emptiedAskHigh) = (null, null);
        LevelsPerSide = snapshot.LevelsPerSide;
        foreach (var level in snapshot.Bids.Where(l => l.Quantity > 0))
        {
            _bids[level.PriceTicks] = level.Quantity;
        }

        foreach (var level in snapshot.Asks.Where(l => l.Quantity > 0))
        {
            _asks[level.PriceTicks] = level.Quantity;
        }

        IsKnown = true;
        Trim();
    }

    /// <summary>Applies an absolute quantity at a price. Returns the change, or null when the book is unknown or nothing changed.</summary>
    public LevelChange? Apply(BookSide side, long priceTicks, long quantity)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(quantity);
        if (!IsKnown)
        {
            DroppedWhileUnknown++;
            return null;
        }

        var levels = side == BookSide.Bid ? _bids : _asks;
        var wasUnknown = UnknownOn(side).Remove(priceTicks);
        levels.TryGetValue(priceTicks, out var previous);
        if (previous == quantity && !wasUnknown)
        {
            return null;
        }

        var (oldLow, oldHigh) = (CoveredLow, CoveredHigh);

        if (quantity == 0)
        {
            levels.Remove(priceTicks);
        }
        else
        {
            levels[priceTicks] = quantity;
            RemoveCrossed(side, priceTicks);
        }

        Trim();
        MarkUncoveredTicksUnknown(oldLow, oldHigh, side, priceTicks);

        // A level deeper than the covered depth is trimmed away, so it is not a change consumers should see; nor is
        // the first update at a tick whose previous size is unknown, because its change cannot be measured.
        return wasUnknown || (quantity > 0 && !levels.ContainsKey(priceTicks))
            ? null
            : new LevelChange(side, priceTicks, previous, quantity);
    }

    /// <summary>Makes every level unknown until the next snapshot (outage, reset or ordering ambiguity).</summary>
    public void Invalidate()
    {
        IsKnown = false;
        _bids.Clear();
        _asks.Clear();
        _unknownBids.Clear();
        _unknownAsks.Clear();
        (_emptiedBidLow, _emptiedAskHigh) = (null, null);
    }

    /// <summary>The resting quantity at a price: null when unknown, zero when known to be empty.</summary>
    public long? QuantityAt(BookSide side, long priceTicks)
    {
        if (!IsCovered(priceTicks) || UnknownOn(side).Contains(priceTicks))
        {
            return null;
        }

        var levels = side == BookSide.Bid ? _bids : _asks;
        return levels.TryGetValue(priceTicks, out var quantity) ? quantity : 0;
    }

    public bool IsCovered(long priceTicks) =>
        IsKnown && CoveredLow is { } low && CoveredHigh is { } high && priceTicks >= low && priceTicks <= high;

    /// <summary>Sum of the top <paramref name="levels"/> price levels on a side, or null when the book is unknown.</summary>
    public long? DepthAt(BookSide side, int levels)
    {
        if (!IsKnown)
        {
            return null;
        }

        var book = side == BookSide.Bid ? _bids : _asks;
        return book.Take(levels).Sum(l => l.Value);
    }

    private void RemoveCrossed(BookSide side, long priceTicks)
    {
        // A bid at or above the best ask (or an ask at or below the best bid) means the opposite levels traded away
        // before their own update arrived; keep the book uncrossed rather than drawing both.
        var opposite = side == BookSide.Bid ? _asks : _bids;
        var crossed = opposite.Keys
            .TakeWhile(p => side == BookSide.Bid ? p <= priceTicks : p >= priceTicks)
            .ToList();
        foreach (var price in crossed)
        {
            opposite.Remove(price);
        }

        // The same holds for the opposite side's unknown ticks: nothing can rest there once this level crosses them.
        UnknownOn(side == BookSide.Bid ? BookSide.Ask : BookSide.Bid)
            .RemoveWhere(p => side == BookSide.Bid ? p <= priceTicks : p >= priceTicks);
    }

    private HashSet<long> UnknownOn(BookSide side) => side == BookSide.Bid ? _unknownBids : _unknownAsks;

    private void MarkUncoveredTicksUnknown(long? oldLow, long? oldHigh, BookSide side, long setPrice)
    {
        // When the best price recedes, coverage widens onto ticks whose levels were trimmed (or never sent): they
        // are unknown, not empty, until the feed updates them (REQUIREMENTS.md FR-11).
        if (oldLow is not null && CoveredLow is null)
        {
            _emptiedBidLow = oldLow;
        }

        if (oldHigh is not null && CoveredHigh is null)
        {
            _emptiedAskHigh = oldHigh;
        }

        if (CoveredLow is { } low)
        {
            // A side that refills covers again every tick below the bound it had when it emptied; those are unknown,
            // except the price just set. With no recorded bound (it was empty in the snapshot), everything up to the
            // new best is.
            var refill = oldLow is null;
            var bound = oldLow ?? _emptiedBidLow ?? BestBid!.Value + 1;
            if (BestAsk is { } ask)
            {
                // No bid can rest at or above the best ask, so bid markers stop below it.
                bound = Math.Min(bound, ask);
            }

            for (var p = low; p < bound; p++)
            {
                if (!refill || side != BookSide.Bid || p != setPrice)
                {
                    _unknownBids.Add(p);
                }
            }
        }

        if (CoveredHigh is { } high)
        {
            var refill = oldHigh is null;
            var bound = oldHigh ?? _emptiedAskHigh ?? BestAsk!.Value - 1;
            if (BestBid is { } bid)
            {
                // No ask can rest at or below the best bid, so ask markers start above it.
                bound = Math.Max(bound, bid);
            }

            for (var p = bound + 1; p <= high; p++)
            {
                if (!refill || side != BookSide.Ask || p != setPrice)
                {
                    _unknownAsks.Add(p);
                }
            }
        }

        // While either side is empty nothing is covered, but the markers must survive until the side refills, or a
        // trimmed level would come back as known and empty.
        if (CoveredLow is not null && CoveredHigh is not null)
        {
            _unknownBids.RemoveWhere(p => !IsCovered(p));
            _unknownAsks.RemoveWhere(p => !IsCovered(p));
        }
    }

    private void Trim()
    {
        // Coverage is the top N ticks from each best price; anything deeper is outside the subscribed depth.
        if (BestBid is { } bid)
        {
            foreach (var price in _bids.Keys.Where(p => p < bid - (LevelsPerSide - 1)).ToList())
            {
                _bids.Remove(price);
            }
        }

        if (BestAsk is { } ask)
        {
            foreach (var price in _asks.Keys.Where(p => p > ask + (LevelsPerSide - 1)).ToList())
            {
                _asks.Remove(price);
            }
        }
    }
}
