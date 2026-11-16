using System.Globalization;

namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>A run through a key level that failed back inside it: a stop run (REQUIREMENTS.md FR-49).</summary>
public sealed record SweepEvent(KeyLevel Level, long ExtremeTicks, long VolumeBeyond, long DurationMs);

/// <summary>
/// Liquidity-sweep detector (ARCHITECTURE.md D-23). Watches key levels where stops cluster: the prior session's
/// high and low and recent swing pivots. A level is breached when a print trades <c>SweepMinTicksBeyond</c> past
/// it; the breach is a sweep when price prints back through the level within <c>SweepReturnMs</c>, and a breakout
/// (the level retired, no signal) when it does not. Each level is used once. Not thread-safe.
/// </summary>
public sealed class SweepDetector(OrderFlowOptions options)
{
    private readonly Dictionary<(long Price, bool IsHigh), WatchedLevel> _levels = [];
    private long _order;

    public IReadOnlyList<KeyLevel> Levels => _levels.Values.Select(w => w.Level).ToList();

    /// <summary>Adds a level to watch; one already watched at the same price and side is kept.</summary>
    public void Watch(KeyLevel level, long? lastPrice)
    {
        ArgumentNullException.ThrowIfNull(level);
        var key = (level.PriceTicks, level.IsHigh);

        // A level the market already trades beyond is not a stop cluster any more.
        if (_levels.ContainsKey(key) || (lastPrice is { } p && (level.IsHigh ? p > level.PriceTicks : p < level.PriceTicks)))
        {
            return;
        }

        _levels[key] = new WatchedLevel(level, ++_order);
        if (_levels.Count > 24)
        {
            _levels.Remove(_levels.MinBy(l => l.Value.AddedOrder).Key);
        }
    }

    public void Clear() => _levels.Clear();

    public IReadOnlyList<SweepEvent> OnTrade(long timeMs, long priceTicks, long quantity)
    {
        var events = new List<SweepEvent>();
        foreach (var (key, watch) in _levels.ToList())
        {
            var level = watch.Level;
            var beyond = level.IsHigh ? priceTicks - level.PriceTicks : level.PriceTicks - priceTicks;
            if (watch.BreachMs is null)
            {
                if (beyond >= options.SweepMinTicksBeyond)
                {
                    watch.BreachMs = timeMs;
                    watch.Extreme = priceTicks;
                    watch.Volume = quantity;
                }

                continue;
            }

            if (timeMs - watch.BreachMs > options.SweepReturnMs)
            {
                // Accepted beyond the level: a breakout, not a sweep.
                _levels.Remove(key);
                continue;
            }

            if (beyond > 0)
            {
                watch.Volume += quantity;
                watch.Extreme = level.IsHigh ? Math.Max(watch.Extreme, priceTicks) : Math.Min(watch.Extreme, priceTicks);
            }
            else if (beyond < 0)
            {
                events.Add(new SweepEvent(level, watch.Extreme, watch.Volume, timeMs - watch.BreachMs.Value));
                _levels.Remove(key);
            }
        }

        return events;
    }

    public static string Describe(SweepEvent sweep)
    {
        ArgumentNullException.ThrowIfNull(sweep);
        return string.Create(CultureInfo.InvariantCulture,
            $"Ran {Math.Abs(sweep.ExtremeTicks - sweep.Level.PriceTicks)} tick(s) through {sweep.Level.Name} on {sweep.VolumeBeyond} contracts, back inside after {sweep.DurationMs / 1000.0:0.#} s");
    }

    private sealed class WatchedLevel(KeyLevel level, long order)
    {
        public KeyLevel Level { get; } = level;

        public long AddedOrder { get; } = order;

        public long? BreachMs { get; set; }

        public long Extreme { get; set; }

        public long Volume { get; set; }
    }
}
