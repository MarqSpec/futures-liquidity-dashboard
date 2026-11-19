using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Plans;


/// <summary>
/// Computes the named plan metrics of REQUIREMENTS.md FR-73 from one <see cref="PlanMarket"/> reading. Pure and deterministic:
/// the same plan and market always give the same metrics, and nothing is stored. A value the inputs cannot support is
/// null with a reason, never zero (REQUIREMENTS.md FR-11). The metrics describe; they predict nothing and trigger nothing
/// (REQUIREMENTS.md FR-6, P1).
/// </summary>
public static class PlanMetricsCalculator
{
    /// <summary>The window the resting size is averaged over (REQUIREMENTS.md FR-12).</summary>
    public const long RestingWindowMs = 10 * MinuteMs;

    /// <summary>How far back a detected signal still counts as in the way or near a leg.</summary>
    public const long SignalWindowMs = 60 * MinuteMs;

    /// <summary>Key levels and order-flow context count within this many ATR of a leg.</summary>
    public const double NearAtr = 2.0;

    /// <summary>A stop up to this many ticks inside a level or wall sits just inside it.</summary>
    public const long StopInsideTicks = 2;

    /// <summary>The one-minute windows trade-through frequency is measured over.</summary>
    public static IReadOnlyList<int> ThroughWindows { get; } = [60, 240];

    /// <summary>The regime timeframes reported, in seconds (UC-19).</summary>
    public static IReadOnlyList<int> RegimeTimeframes { get; } = [300, 900];

    private const long MinuteMs = 60_000;

    private static readonly SignalKind[] InTheWaySignals = [SignalKind.Spoof, SignalKind.LiquiditySweep];

    private static readonly SignalKind[] FlowSignals = [SignalKind.TrappedTraders, SignalKind.CvdDivergence, SignalKind.DeltaExhaustion];

    public static PlanMetrics Compute(PlanSpec plan, PlanMarket market)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(market);
        var reference = plan.EntryTicks ?? (plan.IsMarket ? market.LastTicks : null);
        var legs = new List<LegMetrics>
        {
            Leg(plan, market, "entry", null, reference, restingSide: plan.IsMarket ? null : JoinSide(plan.IsLong, isTarget: false), isTarget: false),
            Leg(plan, market, "stop", null, plan.StopTicks, restingSide: null, isTarget: false),
        };
        for (var i = 0; i < plan.Targets.Count; i++)
        {
            legs.Add(Leg(plan, market, "target", i, plan.Targets[i].PriceTicks, JoinSide(plan.IsLong, isTarget: true), isTarget: true));
        }

        var (stopAtr, stopAtrReason) = StopAtr(plan, market, reference);
        return new PlanMetrics
        {
            Instrument = market.Root,
            ContractId = market.ContractId,
            AsOfMs = market.AsOfMs,
            StatusCode = market.StatusCode,
            LastTicks = market.LastTicks,
            AtrTicks = market.AtrTicks,
            Legs = legs,
            RewardRisk = [.. plan.Targets.Select((t, i) => Reward(plan, reference, i, t))],
            StopAtr = stopAtr,
            StopAtrReason = stopAtrReason,
            StopPlacement = Placement(plan, market),
            MarketSlippage = plan.IsMarket ? Slippage(plan, market.Book) : null,
            Regimes = [.. market.Regimes.Where(r => RegimeTimeframes.Contains(r.TimeframeSeconds)).OrderBy(r => r.TimeframeSeconds)],
            Coverage = market.Coverage,
        };
    }

    // A long buys at the entry and sells at a target; a short does the opposite. The side joined is the one that rests.
    private static BookSide JoinSide(bool isLong, bool isTarget) => isLong != isTarget ? BookSide.Bid : BookSide.Ask;

    private static LegMetrics Leg(PlanSpec plan, PlanMarket market, string name, int? index, long? price, BookSide? restingSide, bool isTarget)
    {
        if (price is not { } p)
        {
            return new LegMetrics(
                name, index, null, null, null, UnknownReasons.NoLastPrice,
                restingSide is { } s ? new RestingSize(Name(s), null, UnknownReasons.NoReferencePrice, null, UnknownReasons.NoReferencePrice, 0, true) : null,
                [], null,
                new InTheWay(market.Book.Known, null, UnknownReasons.NoReferencePrice),
                null, UnknownReasons.NoReferencePrice,
                new FlowContext(null, market.Coverage.FlowPartial, null, null, null, UnknownReasons.NoReferencePrice));
        }

        long? distance = market.LastTicks is { } last ? p - last : null;
        double? distanceAtr = distance is { } d && market.AtrTicks is { } atr && atr > 0 ? Round(d / atr) : null;
        var direction = plan.IsLong != isTarget ? "below" : "above";
        return new LegMetrics(
            name,
            index,
            p,
            distance,
            distanceAtr,
            distance is null ? UnknownReasons.NoLastPrice : null,
            restingSide is { } side ? Resting(market, side, p) : null,
            [.. ThroughWindows.Select(n => Through(market, p, n, direction))],
            LastReached(market, p),
            InTheWay(market, p),
            NearLevels(market, p),
            market.AtrTicks is > 0 ? null : UnknownReasons.AtrUnknown,
            Flow(market, p));
    }

    private static RestingSize Resting(PlanMarket market, BookSide side, long price)
    {
        var book = market.Book;
        var now = book.QuantityAt(side, price);
        var nowReason = now is not null
            ? null
            : !book.Known
                ? UnknownReasons.BookUnknown
                : book.CoveredLow is not { } low || book.CoveredHigh is not { } high || price < low || price > high
                    ? UnknownReasons.OutsideCoveredDepth
                    : UnknownReasons.LevelUnknown;
        // On the slice grid: a read between boundaries still sees the last 600 closed one-second slices as complete.
        var slice = Math.Max(1, market.SliceMs);
        var end = market.AsOfMs - (((market.AsOfMs % slice) + slice) % slice);
        var from = end - RestingWindowMs;
        double quantityMs = 0;
        double knownMs = 0;
        foreach (var column in market.RecentHeat)
        {
            if (column.StartMs < from || column.StartMs >= end)
            {
                continue;
            }

            foreach (var cell in column.Cells)
            {
                if (cell.PriceTicks == price)
                {
                    quantityMs += side == BookSide.Bid ? cell.BidQuantityMs : cell.AskQuantityMs;
                    knownMs += cell.KnownMs;
                }
            }
        }

        double? mean = knownMs > 0 ? Round(quantityMs / knownMs) : null;
        var coverage = Round(Math.Clamp(knownMs / RestingWindowMs, 0, 1));
        return new RestingSize(Name(side), now, nowReason, mean, mean is null ? UnknownReasons.NoKnownTime : null, coverage, coverage < 1);
    }

    private static ThroughFrequency Through(PlanMarket market, long price, int bars, string direction)
    {
        var anchor = market.AsOfMs - (((market.AsOfMs % MinuteMs) + MinuteMs) % MinuteMs);
        var from = anchor - (bars * MinuteMs);
        var slots = new Dictionary<long, PlanMinute>();
        foreach (var minute in market.Minutes)
        {
            if (minute.StartMs >= from && minute.StartMs < anchor)
            {
                slots[minute.StartMs] = minute;
            }
        }

        var known = 0;
        var through = 0;
        foreach (var minute in slots.Values)
        {
            if (minute.Missing)
            {
                continue;
            }

            known++;
            // Strictly through: a bar whose extreme only touches the price did not trade beyond it.
            if (direction == "below" ? minute.Low < price : minute.High > price)
            {
                through++;
            }
        }

        var coverage = Round((double)known / bars);
        return new ThroughFrequency(bars, direction, known, through, known > 0 ? Round((double)through / known) : null, coverage, known < bars);
    }

    private static long? LastReached(PlanMarket market, long price)
    {
        long? newest = null;
        foreach (var minute in market.Minutes)
        {
            if (!minute.Missing && minute.Low <= price && minute.High >= price && (newest is null || minute.StartMs > newest))
            {
                newest = minute.StartMs;
            }
        }

        return newest;
    }

    private static InTheWay InTheWay(PlanMarket market, long price)
    {
        if (market.LastTicks is not { } last)
        {
            return new InTheWay(market.Book.Known, null, UnknownReasons.NoLastPrice);
        }

        // Between the last price and the leg: the leg's price counts, the last price does not.
        var (low, high) = price < last ? (price, last - 1) : (last + 1, price);
        var items = new List<InTheWayItem>();
        if (price != last)
        {
            items.AddRange(market.Walls
                .Where(w => w.PriceTicks >= low && w.PriceTicks <= high)
                .Select(w => new InTheWayItem("wall", Name(w.Side), w.PriceTicks, w.PriceTicks, w.Quantity, w.AgeMs)));
            items.AddRange(market.Icebergs
                .Where(i => i.Active && i.PriceTicks >= low && i.PriceTicks <= high)
                .Select(i => new InTheWayItem("iceberg", Name(i.Side), i.PriceTicks, i.PriceTicks, i.Traded, market.AsOfMs - i.FirstSeenMs)));
            items.AddRange(RecentSignals(market, InTheWaySignals, low, high)
                .Select(s => new InTheWayItem(s.Kind == SignalKind.Spoof ? "spoof" : "sweep", null, s.PriceTicks, s.PriceHighTicks, null, market.AsOfMs - s.TimeMs)));
        }

        return new InTheWay(market.Book.Known, items, null);
    }

    private static IEnumerable<OrderFlowSignal> RecentSignals(PlanMarket market, SignalKind[] kinds, long low, long high) =>
        market.Signals.Where(s =>
            kinds.Contains(s.Kind)
            && market.AsOfMs - s.TimeMs <= SignalWindowMs
            && s.TimeMs <= market.AsOfMs
            && s.PriceTicks <= high
            && s.PriceHighTicks >= low);

    private static (long Low, long High)? NearBand(PlanMarket market, long price)
    {
        if (market.AtrTicks is not { } atr || atr <= 0)
        {
            return null;
        }

        var reach = (long)Math.Floor(NearAtr * atr);
        return (price - reach, price + reach);
    }

    private static List<NearLevel>? NearLevels(PlanMarket market, long price) =>
        NearBand(market, price) is not { } band
            ? null
            : [.. market.Levels
                .Where(l => l.PriceTicks >= band.Low && l.PriceTicks <= band.High)
                .Select(l => new NearLevel(l.Kind, l.Name, l.PriceTicks, l.PriceTicks - price))];

    private static FlowContext Flow(PlanMarket market, long price)
    {
        long? delta = market.SessionDeltaByPrice.TryGetValue(price, out var d) ? d : null;
        if (NearBand(market, price) is not { } band)
        {
            return new FlowContext(delta, market.Coverage.FlowPartial, null, null, null, UnknownReasons.AtrUnknown);
        }

        return new FlowContext(
            delta,
            market.Coverage.FlowPartial,
            [.. market.Zones.Where(z => z.LowTicks <= band.High && z.HighTicks >= band.Low).Select(z => new NearZone(Name(z.Bias), z.LowTicks, z.HighTicks))],
            [.. market.UnfinishedAuctions.Where(a => a.PriceTicks >= band.Low && a.PriceTicks <= band.High).Select(a => new NearAuction(a.PriceTicks, a.AtHigh, a.BarStartMs))],
            [.. RecentSignals(market, FlowSignals, band.Low, band.High)
                .Select(s => new NearSignal(Kebab(s.Kind.ToString()), Name(s.Bias), s.PriceTicks, s.PriceHighTicks, market.AsOfMs - s.TimeMs))],
            null);
    }

    private static long? Risk(PlanSpec plan, long? reference) =>
        reference is { } entry ? (plan.IsLong ? entry - plan.StopTicks : plan.StopTicks - entry) : null;

    private static RewardRisk Reward(PlanSpec plan, long? reference, int index, PlanTarget target)
    {
        if (reference is not { } entry)
        {
            return new RewardRisk(index, target.PriceTicks, null, UnknownReasons.NoReferencePrice);
        }

        var risk = Risk(plan, entry)!.Value;
        if (risk <= 0)
        {
            return new RewardRisk(index, target.PriceTicks, null, UnknownReasons.NoRisk);
        }

        var reward = plan.IsLong ? target.PriceTicks - entry : entry - target.PriceTicks;
        return new RewardRisk(index, target.PriceTicks, Round((double)reward / risk), null);
    }

    private static (double? Value, string? Reason) StopAtr(PlanSpec plan, PlanMarket market, long? reference)
    {
        if (Risk(plan, reference) is not { } risk)
        {
            return (null, UnknownReasons.NoReferencePrice);
        }

        if (risk <= 0)
        {
            return (null, UnknownReasons.NoRisk);
        }

        return market.AtrTicks is { } atr && atr > 0 ? (Round(risk / atr), null) : (null, UnknownReasons.AtrUnknown);
    }

    private static StopPlacement Placement(PlanSpec plan, PlanMarket market)
    {
        var candidates = market.Levels.Select(l => (l.Kind, l.Name, l.PriceTicks))
            .Concat(market.Walls.Select(w => ("wall", $"{Name(w.Side)} wall", w.PriceTicks)));
        var near = new List<StopNear>();
        foreach (var (kind, name, level) in candidates)
        {
            // Inside means on the entry's side of the level: above it for a long, below it for a short.
            var inside = plan.IsLong ? plan.StopTicks - level : level - plan.StopTicks;
            if (inside is >= 1 and <= StopInsideTicks)
            {
                near.Add(new StopNear(kind, name, level, inside));
            }
        }

        return new StopPlacement(near.Count > 0, near, market.Book.Known);
    }

    private static MarketSlippage Slippage(PlanSpec plan, PlanBook book)
    {
        if (!book.Known)
        {
            return new MarketSlippage(null, null, null, null, 0, UnknownReasons.BookUnknown);
        }

        var side = plan.IsLong ? BookSide.Ask : BookSide.Bid;
        if ((plan.IsLong ? book.BestAsk : book.BestBid) is not { } touch)
        {
            return new MarketSlippage(null, null, null, null, 0, UnknownReasons.SideEmpty);
        }

        var step = plan.IsLong ? 1 : -1;
        long remaining = plan.Quantity;
        double notional = 0;
        var walked = 0;
        long worst = touch;
        for (var price = touch; remaining > 0; price += step)
        {
            if (book.CoveredLow is not { } low || book.CoveredHigh is not { } high || price < low || price > high)
            {
                return new MarketSlippage(touch, null, null, null, walked, UnknownReasons.OutsideCoveredDepth);
            }

            if (book.QuantityAt(side, price) is not { } resting)
            {
                return new MarketSlippage(touch, null, null, null, walked, UnknownReasons.LevelUnknown);
            }

            if (resting > 0)
            {
                var take = Math.Min(remaining, resting);
                notional += take * (double)price;
                remaining -= take;
                walked++;
                worst = price;
            }
        }

        var average = notional / plan.Quantity;
        return new MarketSlippage(touch, Round(average), Round(plan.IsLong ? average - touch : touch - average), worst, walked, null);
    }

    // Every enumerated value on the wire is lowercase kebab-case (INTERFACES.md D.1).
    private static string Name(BookSide side) => side == BookSide.Bid ? "bid" : "ask";

    private static string Name(SignalBias bias) => bias switch
    {
        SignalBias.Bullish => "bullish",
        SignalBias.Bearish => "bearish",
        SignalBias.Neutral => "neutral",
        _ => throw new ArgumentOutOfRangeException(nameof(bias)),
    };

    private static string Kebab(string pascal) =>
        string.Concat(pascal.Select((c, i) => char.IsUpper(c) ? (i > 0 ? "-" : string.Empty) + char.ToLowerInvariant(c) : c.ToString()));

    private static double Round(double value) => Math.Round(value, 4, MidpointRounding.AwayFromZero);
}
