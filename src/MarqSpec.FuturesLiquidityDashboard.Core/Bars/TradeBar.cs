namespace MarqSpec.FuturesLiquidityDashboard.Core.Bars;

/// <summary>
/// OHLC and volume from executed trades only (REQUIREMENTS.md FR-13). A bin with no trade is an explicit empty interval:
/// <see cref="IsEmpty"/> is true and the prices are null.
/// </summary>
public sealed record TradeBar
{
    public required long StartMs { get; init; }

    public required int DurationMs { get; init; }

    public long? Open { get; init; }

    public long? High { get; init; }

    public long? Low { get; init; }

    public long? Close { get; init; }

    public long Volume { get; init; }

    /// <summary>Volume where the buyer was the aggressor.</summary>
    public long BuyVolume { get; init; }

    /// <summary>Volume where the seller was the aggressor.</summary>
    public long SellVolume { get; init; }

    public int TradeCount { get; init; }

    public bool IsEmpty => TradeCount == 0;

    public long Delta => BuyVolume - SellVolume;

    public long EndMs => StartMs + DurationMs;

    public static TradeBar Empty(long startMs, int durationMs) => new() { StartMs = startMs, DurationMs = durationMs };

    /// <summary>Adds one execution to the bar.</summary>
    public TradeBar With(long priceTicks, long quantity, bool buyerAggressor) => this with
    {
        Open = Open ?? priceTicks,
        High = High is { } h ? Math.Max(h, priceTicks) : priceTicks,
        Low = Low is { } l ? Math.Min(l, priceTicks) : priceTicks,
        Close = priceTicks,
        Volume = Volume + quantity,
        BuyVolume = BuyVolume + (buyerAggressor ? quantity : 0),
        SellVolume = SellVolume + (buyerAggressor ? 0 : quantity),
        TradeCount = TradeCount + 1,
    };

    /// <summary>Re-aggregates consecutive bars into one wider bar from the same source (REQUIREMENTS.md FR-1).</summary>
    public static TradeBar Combine(long startMs, int durationMs, IEnumerable<TradeBar> bars)
    {
        ArgumentNullException.ThrowIfNull(bars);
        var traded = bars.Where(b => !b.IsEmpty).OrderBy(b => b.StartMs).ToList();
        return traded.Count == 0
            ? Empty(startMs, durationMs)
            : new TradeBar
            {
                StartMs = startMs,
                DurationMs = durationMs,
                Open = traded[0].Open,
                High = traded.Max(b => b.High),
                Low = traded.Min(b => b.Low),
                Close = traded[^1].Close,
                Volume = traded.Sum(b => b.Volume),
                BuyVolume = traded.Sum(b => b.BuyVolume),
                SellVolume = traded.Sum(b => b.SellVolume),
                TradeCount = traded.Sum(b => b.TradeCount),
            };
    }
}
