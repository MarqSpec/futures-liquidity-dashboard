namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>
/// Volume traded at one price inside a footprint bar, split by aggressor: <see cref="BidVolume"/> is selling that
/// hit the bid, <see cref="AskVolume"/> is buying that lifted the offer (REQUIREMENTS.md FR-41).
/// </summary>
public sealed record FootprintCell(long PriceTicks, long BidVolume, long AskVolume)
{
    public long Volume => BidVolume + AskVolume;

    public long Delta => AskVolume - BidVolume;
}

/// <summary>
/// A bar that keeps bid × ask volume at every price (a footprint or volumetric bar). Mutable while it forms;
/// <see cref="FootprintAggregator"/> hands out closed bars that are never changed again.
/// </summary>
public sealed class FootprintBar
{
    private readonly SortedDictionary<long, (long Bid, long Ask)> _cells = [];
    private long _runningDelta;

    public FootprintBar(long startMs, long durationMs)
    {
        StartMs = startMs;
        DurationMs = durationMs;
    }

    public long StartMs { get; }

    public long DurationMs { get; }

    public long EndMs => StartMs + DurationMs;

    public long? Open { get; private set; }

    public long? High { get; private set; }

    public long? Low { get; private set; }

    public long? Close { get; private set; }

    public long Volume { get; private set; }

    public long AskVolume { get; private set; }

    public long BidVolume { get; private set; }

    public long Delta => AskVolume - BidVolume;

    /// <summary>Highest running delta inside the bar.</summary>
    public long MaxDelta { get; private set; }

    /// <summary>Lowest running delta inside the bar.</summary>
    public long MinDelta { get; private set; }

    public bool IsEmpty => Volume == 0;

    public IReadOnlyList<FootprintCell> Cells => _cells.Select(c => new FootprintCell(c.Key, c.Value.Bid, c.Value.Ask)).ToList();

    public FootprintCell CellAt(long priceTicks) =>
        _cells.TryGetValue(priceTicks, out var c) ? new FootprintCell(priceTicks, c.Bid, c.Ask) : new FootprintCell(priceTicks, 0, 0);

    public void Add(long priceTicks, long quantity, bool buyerAggressor)
    {
        if (quantity <= 0)
        {
            return;
        }

        Open ??= priceTicks;
        High = High is { } h ? Math.Max(h, priceTicks) : priceTicks;
        Low = Low is { } l ? Math.Min(l, priceTicks) : priceTicks;
        Close = priceTicks;
        Volume += quantity;
        _cells.TryGetValue(priceTicks, out var cell);
        if (buyerAggressor)
        {
            AskVolume += quantity;
            _runningDelta += quantity;
            _cells[priceTicks] = (cell.Bid, cell.Ask + quantity);
        }
        else
        {
            BidVolume += quantity;
            _runningDelta -= quantity;
            _cells[priceTicks] = (cell.Bid + quantity, cell.Ask);
        }

        MaxDelta = Math.Max(MaxDelta, _runningDelta);
        MinDelta = Math.Min(MinDelta, _runningDelta);
    }
}

/// <summary>Builds consecutive footprint bars on half-open bins, closing empty bins too.</summary>
public sealed class FootprintAggregator(int intervalMs)
{
    public int IntervalMs { get; } = intervalMs > 0 ? intervalMs : throw new ArgumentOutOfRangeException(nameof(intervalMs));

    public FootprintBar? Current { get; private set; }

    public IReadOnlyList<FootprintBar> Add(long timeMs, long priceTicks, long quantity, bool buyerAggressor)
    {
        var closed = AdvanceTo(timeMs);
        Current ??= new FootprintBar(Floor(timeMs), IntervalMs);
        Current.Add(priceTicks, quantity, buyerAggressor);
        return closed;
    }

    public IReadOnlyList<FootprintBar> AdvanceTo(long timeMs)
    {
        var closed = new List<FootprintBar>();
        if (Current is null)
        {
            return closed;
        }

        var guard = 0;
        while (timeMs >= Current.EndMs && guard++ < 10_000)
        {
            closed.Add(Current);
            Current = new FootprintBar(Current.EndMs, IntervalMs);
        }

        if (timeMs >= Current.EndMs)
        {
            Current = new FootprintBar(Floor(timeMs), IntervalMs);
        }

        return closed;
    }

    public long Floor(long ms) => ms - (((ms % IntervalMs) + IntervalMs) % IntervalMs);
}
