using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>A large resting order that was cancelled, not traded, as the market came near it (REQUIREMENTS.md FR-48).</summary>
/// <param name="DistanceTicks">How far the best price on the order's side was from it when it was pulled.</param>
/// <param name="FurthestTicks">The furthest away the market was while the order rested, so the approach is visible.</param>
public sealed record SpoofEvent(BookSide Side, long PriceTicks, long PeakQuantity, long Pulled, long Filled, long RestedMs, int DistanceTicks, int FurthestTicks);

/// <summary>
/// Phantom-liquidity detector (ARCHITECTURE.md D-22). A level becomes a candidate when it reaches
/// <c>SpoofMinMultiple</c> times the median resting level. Each decrease at a candidate is split into filled (matched
/// against prints at that price in the last two seconds) and pulled (the rest). The candidate is judged when it
/// falls back below half the large threshold: it is a spoof when it rested at least <c>SpoofMinRestMs</c>, at least
/// <c>SpoofMinPulledFraction</c> of its peak was cancelled, at most <c>SpoofMaxFilledFraction</c> traded, the
/// market was within <c>SpoofProximityTicks</c> when it went, and the market had been further away before (it
/// approached). Intent cannot be seen in a feed, so a spoof here means "large size withdrawn on approach", never an
/// accusation about a participant. Not thread-safe.
/// </summary>
public sealed class SpoofDetector(OrderFlowOptions options)
{
    private const long FillMatchMs = 2_000;
    private readonly Dictionary<(BookSide Side, long Price), Candidate> _candidates = [];
    private readonly Dictionary<(BookSide Side, long Price), (long TimeMs, long Quantity)> _recentFills = [];

    public void OnTrade(long timeMs, long priceTicks, long quantity, BookSide restingSide)
    {
        var key = (restingSide, priceTicks);
        _recentFills[key] = _recentFills.TryGetValue(key, out var f) && timeMs - f.TimeMs <= FillMatchMs
            ? (timeMs, f.Quantity + quantity)
            : (timeMs, quantity);
        if (_candidates.TryGetValue(key, out var candidate))
        {
            candidate.Filled += quantity;
        }
    }

    /// <returns>A spoof when this change completed one.</returns>
    public SpoofEvent? OnLevelChange(long timeMs, LevelChange change, OrderBook book)
    {
        ArgumentNullException.ThrowIfNull(book);
        var key = (change.Side, change.PriceTicks);
        var threshold = LargeThreshold(book);
        var distance = Distance(change.Side, change.PriceTicks, book);
        if (_candidates.TryGetValue(key, out var candidate))
        {
            if (change.Delta < 0)
            {
                var decrease = -change.Delta;
                var matched = 0L;
                if (_recentFills.TryGetValue(key, out var fills) && timeMs - fills.TimeMs <= FillMatchMs)
                {
                    matched = Math.Min(decrease, fills.Quantity);
                    _recentFills[key] = (fills.TimeMs, fills.Quantity - matched);
                }

                candidate.Pulled += decrease - matched;
            }

            candidate.Peak = Math.Max(candidate.Peak, change.Quantity);
            if (distance is { } d)
            {
                candidate.Furthest = Math.Max(candidate.Furthest, d);
            }

            if (change.Quantity < threshold / 2)
            {
                _candidates.Remove(key);
                return Judge(change.Side, change.PriceTicks, candidate, timeMs, distance);
            }

            return null;
        }

        if (change.Quantity >= threshold && distance is { } start)
        {
            _candidates[key] = new Candidate { SinceMs = timeMs, Peak = change.Quantity, Furthest = start };
        }

        return null;
    }

    /// <summary>Keeps the approach distance current for every candidate as the market moves.</summary>
    public void OnBookMoved(OrderBook book)
    {
        ArgumentNullException.ThrowIfNull(book);
        foreach (var ((side, price), candidate) in _candidates)
        {
            if (Distance(side, price, book) is { } d)
            {
                candidate.Furthest = Math.Max(candidate.Furthest, d);
            }
        }
    }

    public void Reset()
    {
        _candidates.Clear();
        _recentFills.Clear();
    }

    public void Expire(long nowMs)
    {
        foreach (var key in _recentFills.Where(f => nowMs - f.Value.TimeMs > FillMatchMs).Select(f => f.Key).ToList())
        {
            _recentFills.Remove(key);
        }
    }

    private SpoofEvent? Judge(BookSide side, long price, Candidate c, long timeMs, int? distance)
    {
        var rested = timeMs - c.SinceMs;
        if (distance is not { } d
            || rested < options.SpoofMinRestMs
            || c.Pulled < options.SpoofMinPulledFraction * c.Peak
            || c.Filled > options.SpoofMaxFilledFraction * c.Peak
            || d > options.SpoofProximityTicks
            || c.Furthest <= d)
        {
            return null;
        }

        return new SpoofEvent(side, price, c.Peak, c.Pulled, c.Filled, rested, d, c.Furthest);
    }

    private double LargeThreshold(OrderBook book)
    {
        var sizes = book.Bids.Select(l => l.Value).Concat(book.Asks.Select(l => l.Value)).Order().ToList();
        if (sizes.Count < 4)
        {
            return double.MaxValue;
        }

        return Math.Max(2, sizes[sizes.Count / 2] * options.SpoofMinMultiple);
    }

    private static int? Distance(BookSide side, long price, OrderBook book) => side == BookSide.Bid
        ? book.BestBid is { } bid ? (int)Math.Max(0, bid - price) : null
        : book.BestAsk is { } ask ? (int)Math.Max(0, price - ask) : null;

    private sealed class Candidate
    {
        public long SinceMs { get; init; }

        public long Peak { get; set; }

        public long Pulled { get; set; }

        public long Filled { get; set; }

        public int Furthest { get; set; }
    }
}
