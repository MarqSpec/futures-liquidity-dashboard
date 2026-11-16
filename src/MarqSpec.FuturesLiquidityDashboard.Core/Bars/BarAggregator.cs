namespace MarqSpec.FuturesLiquidityDashboard.Core.Bars;

/// <summary>
/// Builds consecutive bars of one interval from trades on half-open bins. Every elapsed bin closes, including
/// those with no trade, so gaps stay explicit (REQUIREMENTS.md FR-13). Not thread-safe: one engine owns it.
/// </summary>
public sealed class BarAggregator(int intervalMs)
{
    private TradeBar? _current;

    public int IntervalMs { get; } = intervalMs > 0 ? intervalMs : throw new ArgumentOutOfRangeException(nameof(intervalMs));

    /// <summary>The bar still forming, if any.</summary>
    public TradeBar? Current => _current;

    /// <summary>Adds a trade; returns the bars it closed.</summary>
    public IReadOnlyList<TradeBar> Add(long timeMs, long priceTicks, long quantity, bool buyerAggressor)
    {
        var closed = AdvanceTo(timeMs);
        _current ??= TradeBar.Empty(Floor(timeMs), IntervalMs);
        _current = _current.With(priceTicks, quantity, buyerAggressor);
        return closed;
    }

    /// <summary>Closes every bin that ended at or before <paramref name="timeMs"/>.</summary>
    public IReadOnlyList<TradeBar> AdvanceTo(long timeMs)
    {
        var closed = new List<TradeBar>();
        if (_current is null)
        {
            return closed;
        }

        // Cap the catch-up so a long outage cannot allocate millions of empty bins; the engine bounds retention anyway.
        var guard = 0;
        while (timeMs >= _current.EndMs && guard++ < 100_000)
        {
            closed.Add(_current);
            _current = TradeBar.Empty(_current.EndMs, IntervalMs);
        }

        if (timeMs >= _current.EndMs)
        {
            _current = TradeBar.Empty(Floor(timeMs), IntervalMs);
        }

        return closed;
    }

    public long Floor(long ms) => ms - (((ms % IntervalMs) + IntervalMs) % IntervalMs);
}
