using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;

/// <summary>
/// Finds resting levels at least <c>multiple</c> times the median covered level and tracks since when each has
/// stayed that large. A level that drops below the threshold loses its age.
/// </summary>
public sealed class WallDetector(double multiple = 3.0, int perSide = 3)
{
    private readonly Dictionary<(BookSide, long), long> _since = [];

    public IReadOnlyList<LiquidityWall> Detect(long nowMs, OrderBook book)
    {
        ArgumentNullException.ThrowIfNull(book);
        if (!book.IsKnown)
        {
            _since.Clear();
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
        foreach (var gone in _since.Keys.Where(k => !keys.Contains(k)).ToList())
        {
            _since.Remove(gone);
        }

        foreach (var key in keys)
        {
            _since.TryAdd(key, nowMs);
        }

        return large
            .GroupBy(l => l.Side)
            .SelectMany(g => g.OrderByDescending(l => l.Value).Take(perSide))
            .Select(l => new LiquidityWall(l.Side, l.Key, l.Value, nowMs - _since[(l.Side, l.Key)]))
            .OrderBy(w => w.Side).ThenByDescending(w => w.Quantity)
            .ToList();
    }
}
