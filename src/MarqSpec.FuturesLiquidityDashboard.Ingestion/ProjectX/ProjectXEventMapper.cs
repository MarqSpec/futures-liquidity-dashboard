using System.Globalization;
using MarqSpec.Client.ProjectX.Api.Models;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

/// <summary>
/// Turns ProjectX gateway market-hub payloads into normalized events (INTERFACES.md Interface A.5,
/// ARCHITECTURE.md D-15). Pure and stateless apart from the per-contract sequence and tick-rule memory the caller
/// owns, so it is unit-tested without a connection. Mapping, from the gateway's realtime documentation:
/// <list type="bullet">
/// <item><c>GatewayDepth</c> rows of type Bid, BestBid, NewBestBid → bid level; Ask, BestAsk, NewBestAsk → ask level.
/// <c>volume</c> is the total resting size at the price, so it maps to an absolute quantity (0 removes the level).</item>
/// <item>Reset → a book reset: the book is unknown until the next snapshot.</item>
/// <item>Trade, Fill, Low, High, Unknown rows → ignored: executions come from <c>GatewayTrade</c>.</item>
/// <item><c>GatewayTrade</c> type Buy (0) → buyer aggressor, Sell (1) → seller aggressor; when the venue omits it the
/// tick rule against the previous print decides, and the print is still counted.</item>
/// </list>
/// Prices that are not on the contract's tick grid are refused (REQUIREMENTS.md FR-5).
/// </summary>
public static class ProjectXEventMapper
{
    public enum DepthAction
    {
        Ignore,
        Level,
        Reset,
    }

    public static DepthAction Classify(DomType type) => type switch
    {
        DomType.Bid or DomType.BestBid or DomType.NewBestBid or DomType.Ask or DomType.BestAsk or DomType.NewBestAsk => DepthAction.Level,
        DomType.Reset => DepthAction.Reset,
        _ => DepthAction.Ignore,
    };

    public static BookSide? SideOf(DomType type) => type switch
    {
        DomType.Bid or DomType.BestBid or DomType.NewBestBid => BookSide.Bid,
        DomType.Ask or DomType.BestAsk or DomType.NewBestAsk => BookSide.Ask,
        _ => null,
    };

    /// <summary>A depth row as (side, price ticks, quantity), or null when it is not a level or is off the grid.</summary>
    public static (BookSide Side, long PriceTicks, long Quantity)? Level(OrderBookUpdate row, InstrumentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(row);
        ArgumentNullException.ThrowIfNull(spec);
        if (SideOf(row.Type) is not { } side || !spec.TryToTicks(row.Price, out var ticks))
        {
            return null;
        }

        return (side, ticks, Math.Max(0, (long)Math.Round(row.Volume, MidpointRounding.AwayFromZero)));
    }

    /// <summary>A gateway trade as a normalized trade, or null when the price is off the grid or the size is not positive.</summary>
    /// <param name="previousPriceTicks">The previous print's price, for the tick rule when the aggressor is missing.</param>
    /// <param name="previousAggressor">The previous print's aggressor, for the tick rule on an unchanged price.</param>
    public static TradeEvent? Trade(
        TradeUpdate trade,
        InstrumentSpec spec,
        long receivedMs,
        long epoch,
        long sequence,
        long? previousPriceTicks,
        BookSide? previousAggressor)
    {
        ArgumentNullException.ThrowIfNull(trade);
        ArgumentNullException.ThrowIfNull(spec);
        var quantity = (long)Math.Round(trade.Volume, MidpointRounding.AwayFromZero);
        if (quantity <= 0 || !spec.TryToTicks(trade.Price, out var ticks))
        {
            return null;
        }

        var aggressor = trade.Type switch
        {
            TradeLogType.Buy => BookSide.Bid,
            TradeLogType.Sell => BookSide.Ask,
            _ => previousPriceTicks is { } prev && ticks != prev
                ? ticks > prev ? BookSide.Bid : BookSide.Ask
                : previousAggressor ?? BookSide.Bid,
        };
        var sourceMs = ToUnixMs(trade.Timestamp, receivedMs);
        return new TradeEvent
        {
            Root = spec.Root,
            ContractId = spec.ContractId,
            SourceTimeMs = sourceMs,
            ReceivedTimeMs = receivedMs,
            Epoch = epoch,
            Sequence = sequence,
            PriceTicks = ticks,
            Quantity = quantity,
            Aggressor = aggressor,

            // The gateway sends no trade id; epoch and sequence make one unique for the process, because each stream
            // run starts its epochs above the last (ProjectXMarketFeed.EpochBase).
            TradeId = string.Create(CultureInfo.InvariantCulture, $"PX-{spec.Root}-{epoch}-{sequence}"),
        };
    }

    /// <summary>Gateway timestamps are UTC; an unset one falls back to the receive time.</summary>
    public static long ToUnixMs(DateTime timestamp, long fallbackMs)
    {
        if (timestamp == default)
        {
            return fallbackMs;
        }

        var utc = timestamp.Kind switch
        {
            DateTimeKind.Utc => timestamp,
            DateTimeKind.Local => timestamp.ToUniversalTime(),
            _ => DateTime.SpecifyKind(timestamp, DateTimeKind.Utc),
        };
        return new DateTimeOffset(utc).ToUnixTimeMilliseconds();
    }

    /// <summary>
    /// Expands a one-minute bar into warmup prints (ARCHITECTURE.md D-15): four points 15 s apart (open, low, high,
    /// close for an up or flat bar; open, high, low, close for a down bar), the bar's exact volume split as evenly
    /// as whole contracts allow (earlier points take the remainder; with fewer than four contracts, the close, then the
    /// open, then any extreme that differs from both get one each, so OHLC survives), and each point
    /// split between a buyer print and a seller print, so up to eight prints. The
    /// gateway's history has no aggressor, so delta from history is zero by construction (within one contract per bar) and CVD counts from the
    /// start of live collection. These prints are not tape: the engine keeps them out of <c>Prints</c>, and the chart
    /// draws no aggressor-colored dot at or before <c>historyWatermarkMs</c> (REQUIREMENTS.md FR-61).
    /// </summary>
    /// <summary>
    /// A closed one-minute bar in ticks, or null when the bar has no usable price. Volume may be zero: a quiet
    /// minute still covers the gap's end. The timestamp is the bar's start, matching <see cref="FromBar"/>.
    /// </summary>
    public static HistoricalMinuteBar? ToClosedMinute(AggregateBar bar, InstrumentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(bar);
        ArgumentNullException.ThrowIfNull(spec);
        if (!spec.TryToTicks(bar.Open, out var open)
            || !spec.TryToTicks(bar.High, out var high)
            || !spec.TryToTicks(bar.Low, out var low)
            || !spec.TryToTicks(bar.Close, out var close)
            || high < low)
        {
            return null;
        }

        return new HistoricalMinuteBar(ToUnixMs(bar.Timestamp, 0), open, high, low, close, bar.Volume);
    }

    public static IEnumerable<TradeEvent> FromBar(AggregateBar bar, InstrumentSpec spec, ref long sequence)
    {
        ArgumentNullException.ThrowIfNull(bar);
        ArgumentNullException.ThrowIfNull(spec);
        var list = new List<TradeEvent>(8);
        if (bar.Volume <= 0
            || !spec.TryToTicks(bar.Open, out var open)
            || !spec.TryToTicks(bar.High, out var high)
            || !spec.TryToTicks(bar.Low, out var low)
            || !spec.TryToTicks(bar.Close, out var close))
        {
            return list;
        }

        var startMs = ToUnixMs(bar.Timestamp, 0);
        long[] path = close >= open ? [open, low, high, close] : [open, high, low, close];
        var volumes = SplitVolume(bar.Volume, path, open, high, low, close);
        var printIndex = 0;
        for (var i = 0; i < path.Length; i++)
        {
            var volume = volumes[i];
            // Alternate which side takes an odd contract, so the bar's delta stays at zero (within one contract).
            var buy = i % 2 == 0 ? (volume + 1) / 2 : volume / 2;
            foreach (var (side, qty) in new[] { (BookSide.Bid, buy), (BookSide.Ask, volume - buy) })
            {
                if (qty <= 0)
                {
                    continue;
                }

                sequence++;
                list.Add(new TradeEvent
                {
                    Root = spec.Root,
                    ContractId = spec.ContractId,
                    SourceTimeMs = startMs + (i * 15_000),
                    ReceivedTimeMs = startMs + (i * 15_000),
                    Epoch = 0,
                    Sequence = sequence,
                    PriceTicks = path[i],
                    Quantity = qty,
                    Aggressor = side,
                    // The index is this print's place in the bar, so the same warmup bar always has the same ids.
                    TradeId = string.Create(CultureInfo.InvariantCulture, $"PXH-{spec.Root}-{startMs}-{printIndex++}"),
                });
            }
        }

        return list;
    }

    private static long[] SplitVolume(long total, long[] path, long open, long high, long low, long close)
    {
        var volumes = new long[path.Length];
        if (total >= path.Length)
        {
            // Every point gets a print; the earlier points take the remainder.
            for (var i = 0; i < path.Length; i++)
            {
                volumes[i] = (total / path.Length) + (i < total % path.Length ? 1 : 0);
            }

            return volumes;
        }

        // Fewer contracts than points: a real bar with so few trades has at most that many distinct prices, so spend
        // them on the close, then the open, then any extreme that is neither, and the rebuilt bar keeps its OHLC.
        var highIndex = Array.IndexOf(path, high, 1);
        var lowIndex = Array.IndexOf(path, low, 1);
        var remaining = total;
        var spent = new HashSet<long>();
        foreach (var (index, price) in new[] { (path.Length - 1, close), (0, open), (highIndex, high), (lowIndex, low) })
        {
            if (remaining > 0 && spent.Add(price))
            {
                volumes[index]++;
                remaining--;
            }
        }

        volumes[^1] += remaining;
        return volumes;
    }
}
