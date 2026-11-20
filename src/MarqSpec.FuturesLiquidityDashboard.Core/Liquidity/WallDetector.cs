using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;

/// <summary>
/// Finds resting levels at least <c>multiple</c> times the median covered level and tracks since when each has
/// stayed that large. A level that drops below the threshold loses its age (REQUIREMENTS.md FR-40). A reported wall that
/// stops being one is kept as an <see cref="EndedWall"/>, with how its size left judged from FR-38's split, when every
/// size it went through was seen as a change; a later end at the same side and price replaces the earlier entry
/// (REQUIREMENTS.md FR-78, ARCHITECTURE.md D-64).
/// </summary>
public sealed class WallDetector(double multiple = 3.0, int perSide = 3)
{

    /// <summary>How many ended walls are kept per product.</summary>
    public const int EndedKept = 5;

    /// <summary>How long an ended wall is shown after it ended.</summary>
    public const long EndedShownMs = 15 * 60_000;

    private readonly Dictionary<(BookSide, long), Tracked> _tracked = [];
    private readonly LinkedList<EndedWall> _ended = new();

    public IReadOnlyList<LiquidityWall> Detect(long nowMs, OrderBook book)
    {
        ArgumentNullException.ThrowIfNull(book);
        if (!book.IsKnown)
        {
            _tracked.Clear();
            return [];
        }

        var levels = book.Bids.Select(l => (Side: BookSide.Bid, l.Key, l.Value))
            .Concat(book.Asks.Select(l => (Side: BookSide.Ask, l.Key, l.Value)))
            .ToList();
        if (levels.Count < 4)
        {
            return [];
        }

        var sorted = levels.Select(l => l.Value).Order().ToList();
        var median = sorted[sorted.Count / 2];
        var threshold = Math.Max(1, median * multiple);
        var large = levels.Where(l => l.Value >= threshold).ToList();
        var keys = large.Select(l => (l.Side, l.Key)).ToHashSet();
        foreach (var gone in _tracked.Keys.Where(k => !keys.Contains(k)).ToList())
        {
            End(gone, _tracked[gone], nowMs, book);
            _tracked.Remove(gone);
        }

        foreach (var (side, price, quantity) in large)
        {
            if (!_tracked.TryGetValue((side, price), out var tracked))
            {
                tracked = new Tracked { SinceMs = nowMs, Last = quantity };
                _tracked[(side, price)] = tracked;
            }
            else if (quantity != tracked.Last)
            {
                // The size moved with no change reported to this detector, so its split is missing part of it.
                tracked.Gap = true;
                tracked.Last = quantity;
            }

            tracked.Peak = Math.Max(tracked.Peak, quantity);
        }

        var walls = large
            .GroupBy(l => l.Side)
            .SelectMany(g => g.OrderByDescending(l => l.Value).Take(perSide))
            .Select(l => new LiquidityWall(l.Side, l.Key, l.Value, nowMs - _tracked[(l.Side, l.Key)].SinceMs))
            .OrderBy(w => w.Side).ThenByDescending(w => w.Quantity)
            .ToList();
        foreach (var wall in walls)
        {
            _tracked[(wall.Side, wall.PriceTicks)].Reported = true;
        }

        return walls;
    }

    /// <summary>Adds one change of resting quantity, as FR-38 split it, to the wall standing at that price.</summary>
    public void OnLevelChange(LevelChange change, FlowSplit split)
    {
        if (!_tracked.TryGetValue((change.Side, change.PriceTicks), out var tracked))
        {
            return;
        }

        if (change.PreviousQuantity != tracked.Last)
        {
            tracked.Gap = true;
        }

        tracked.Last = change.Quantity;
        tracked.Peak = Math.Max(tracked.Peak, Math.Max(change.PreviousQuantity, change.Quantity));
        tracked.Filled += split.Filled;
        tracked.Pulled += split.Pulled;
    }

    /// <summary>The walls that ended less than <see cref="EndedShownMs"/> ago, newest first.</summary>
    public IReadOnlyList<EndedWall> Ended(long nowMs)
    {
        while (_ended.Last is { } oldest && nowMs - oldest.Value.EndedMs >= EndedShownMs)
        {
            _ended.RemoveLast();
        }

        return [.. _ended];
    }

    /// <summary>Forgets the walls standing across a book reset or a new baseline: what happened to them was not seen.</summary>
    public void Reset() => _tracked.Clear();

    private void End((BookSide Side, long Price) key, Tracked tracked, long nowMs, OrderBook book)
    {
        // Past the covered depth the level is unknown, not gone (FR-11): the wall left sight, it did not end.
        if (!tracked.Reported || book.QuantityAt(key.Side, key.Price) is not { } remaining)
        {
            return;
        }

        // A crossing level or a tick that went unknown moves size with no change: an outcome would be a guess.
        if (tracked.Gap || remaining != tracked.Last)
        {
            return;
        }

        var outcome = remaining * 2 >= tracked.Peak ? WallOutcome.BelowThreshold
            : tracked.Pulled > tracked.Filled ? WallOutcome.Pulled
            : WallOutcome.Filled;

        // One entry per side and price, so a level dipping under the threshold cannot fill every slot.
        for (var node = _ended.First; node is not null; node = node.Next)
        {
            if (node.Value.Side == key.Side && node.Value.PriceTicks == key.Price)
            {
                _ended.Remove(node);
                break;
            }
        }

        _ended.AddFirst(new EndedWall(key.Side, key.Price, tracked.Peak, tracked.Filled, tracked.Pulled, nowMs - tracked.SinceMs, nowMs, outcome));
        while (_ended.Count > EndedKept)
        {
            _ended.RemoveLast();
        }
    }

    private sealed class Tracked
    {
        public long SinceMs { get; init; }

        public long Peak { get; set; }

        public long Filled { get; set; }

        public long Pulled { get; set; }

        /// <summary>Listed among the largest walls at least once, so the reader saw it.</summary>
        public bool Reported { get; set; }

        /// <summary>The size this detector last knew the level to have.</summary>
        public long Last { get; set; }

        /// <summary>The size once moved with no change seen, so the split does not account for all of it.</summary>
        public bool Gap { get; set; }
    }
}
