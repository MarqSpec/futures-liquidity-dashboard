using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>A resting level that traded more than it ever showed and kept refilling (REQUIREMENTS.md FR-52).</summary>
/// <param name="Side">The resting side: a bid iceberg absorbs selling, an ask iceberg absorbs buying.</param>
/// <param name="Traded">Volume printed against the level during the episode.</param>
/// <param name="PeakDisplayed">The most ever displayed at the level at once during the episode.</param>
/// <param name="HiddenEstimate">Volume executed beyond what was ever displayed at once: a lower bound on the hidden size.</param>
/// <param name="Confidence">0–1, from the traded-to-displayed ratio and the refill count (ARCHITECTURE.md D-19).</param>
public sealed record IcebergReading(
    BookSide Side,
    long PriceTicks,
    long Traded,
    long Displayed,
    long PeakDisplayed,
    int Refills,
    long AverageRefill,
    long HiddenEstimate,
    double Confidence,
    long FirstSeenMs,
    long LastFillMs,
    bool Active);

/// <summary>
/// Infers hidden (iceberg) orders from prints and depth (ARCHITECTURE.md D-19). Per resting price it opens an
/// episode on the first print against the level and counts the volume traded there, the most displayed at once,
/// and the refills: size increases at that price within <c>IcebergRefillWindowMs</c> of a print. A level is called
/// an iceberg once it has refilled at least <c>IcebergMinRefills</c> times and traded at least
/// <c>IcebergMinTradedMultiple</c> times its peak displayed size. Confidence = 0.6 × (1 − e^−(traded/peak − 1)) +
/// 0.4 × min(1, refills/6). A refill can also be a different participant joining, which is why it is a confidence
/// and not a certainty. Not thread-safe: the engine owns it.
/// </summary>
public sealed class IcebergDetector(OrderFlowOptions options)
{
    private readonly Dictionary<(BookSide Side, long Price), Episode> _episodes = [];

    /// <summary>A print. <paramref name="displayed"/> is the resting size at that price before this print reached the book.</summary>
    /// <returns>The reading when this print made the level an iceberg for the first time.</returns>
    public IcebergReading? OnTrade(long timeMs, long priceTicks, long quantity, BookSide restingSide, long? displayed)
    {
        var key = (restingSide, priceTicks);
        if (!_episodes.TryGetValue(key, out var episode) || !episode.Open)
        {
            episode = new Episode { FirstMs = timeMs, Displayed = displayed ?? 0, Peak = displayed ?? 0 };
            _episodes[key] = episode;
        }

        episode.Traded += quantity;
        episode.LastFillMs = timeMs;
        episode.LastEventMs = timeMs;
        return Evaluate(key, episode);
    }

    /// <summary>A depth change at a price the detector may be watching.</summary>
    public IcebergReading? OnLevelChange(long timeMs, LevelChange change)
    {
        var key = (change.Side, change.PriceTicks);
        if (!_episodes.TryGetValue(key, out var episode) || !episode.Open)
        {
            return null;
        }

        if (change.Quantity > change.PreviousQuantity && timeMs - episode.LastFillMs <= options.IcebergRefillWindowMs)
        {
            episode.Refills++;
            episode.RefillQuantity += change.Quantity - change.PreviousQuantity;
        }

        episode.Displayed = change.Quantity;
        episode.Peak = Math.Max(episode.Peak, change.Quantity);
        episode.LastEventMs = timeMs;
        if (change.Quantity == 0)
        {
            // The level is gone: consumed or cancelled. A detected iceberg stays listed as closed.
            Close(episode, timeMs);
            return null;
        }

        return Evaluate(key, episode);
    }

    /// <summary>Closes idle episodes and forgets old closed ones.</summary>
    public void Expire(long nowMs)
    {
        foreach (var (key, episode) in _episodes.ToList())
        {
            if (episode.Open && nowMs - episode.LastFillMs > options.IcebergIdleMs)
            {
                Close(episode, nowMs);
            }

            if (!episode.Open && (!episode.Detected || nowMs - episode.ClosedMs > options.IcebergRetainMs))
            {
                _episodes.Remove(key);
            }
        }
    }

    /// <summary>Forgets every episode: the book is no longer known, so refills cannot be seen.</summary>
    public void Reset() => _episodes.Clear();

    /// <summary>Detected icebergs, active first, then by confidence.</summary>
    public IReadOnlyList<IcebergReading> Readings(int max = 8) => _episodes
        .Where(e => e.Value.Detected)
        .Select(e => Reading(e.Key, e.Value))
        .OrderByDescending(r => r.Active)
        .ThenByDescending(r => r.Confidence)
        .Take(max)
        .ToList();

    public static double Confidence(long traded, long peak, int refills)
    {
        var ratio = (double)traded / Math.Max(1, peak);
        if (ratio <= 1)
        {
            return 0;
        }

        return Math.Round((0.6 * (1 - Math.Exp(-(ratio - 1)))) + (0.4 * Math.Min(1, refills / 6.0)), 3);
    }

    private IcebergReading? Evaluate((BookSide Side, long Price) key, Episode episode)
    {
        var confidence = Confidence(episode.Traded, episode.Peak, episode.Refills);
        var qualifies = episode.Refills >= options.IcebergMinRefills
            && episode.Traded >= options.IcebergMinTradedMultiple * Math.Max(1, episode.Peak)
            && confidence >= options.IcebergMinConfidence;
        if (!qualifies || episode.Detected)
        {
            return null;
        }

        episode.Detected = true;
        return Reading(key, episode);
    }

    private static void Close(Episode episode, long nowMs)
    {
        episode.Open = false;
        episode.ClosedMs = nowMs;
    }

    private static IcebergReading Reading((BookSide Side, long Price) key, Episode e) => new(
        key.Side,
        key.Price,
        e.Traded,
        e.Displayed,
        e.Peak,
        e.Refills,
        e.Refills == 0 ? 0 : e.RefillQuantity / e.Refills,
        Math.Max(0, e.Traded - e.Peak),
        Confidence(e.Traded, e.Peak, e.Refills),
        e.FirstMs,
        e.LastFillMs,
        e.Open);

    private sealed class Episode
    {
        public long FirstMs { get; init; }

        public long Displayed { get; set; }

        public long Peak { get; set; }

        public long Traded { get; set; }

        public int Refills { get; set; }

        public long RefillQuantity { get; set; }

        public long LastFillMs { get; set; }

        public long LastEventMs { get; set; }

        public bool Open { get; set; } = true;

        public bool Detected { get; set; }

        public long ClosedMs { get; set; }
    }
}
