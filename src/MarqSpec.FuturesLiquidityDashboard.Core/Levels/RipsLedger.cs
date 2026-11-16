using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Levels;

/// <summary>
/// Running high, low and open for RIPS windows (REQUIREMENTS.md FR-63, ARCHITECTURE.md D-35). PDH, PDL, Asia and the prior
/// week are remembered only when one minute covers the window open and one covers its close, and they stay after
/// those minutes are trimmed. A partial warmup is not those levels.
/// </summary>
public sealed class RipsLedger
{
    private readonly Dictionary<string, Extreme> _rth = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Extreme> _asia = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Extreme> _weeks = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Extreme> _fourHour = new(StringComparer.Ordinal);

    /// <summary>Folds one closed minute into every window it intersects. Repeating a bar does not change the extreme.</summary>
    public void Observe(InstrumentSpec spec, ExchangeCalendar calendar, MinuteRange bar)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(calendar);
        if (bar.High < bar.Low)
        {
            return;
        }

        var start = DateTimeOffset.FromUnixTimeMilliseconds(bar.StartMs);
        var tradeDate = calendar.SessionFor(start).TradeDate;
        if (RipsSessions.Rth(calendar, spec, tradeDate) is { } rth)
        {
            Touch(_rth, rth.SessionId, bar, rth.OpenMs, rth.CloseMs);
        }

        if (RipsSessions.Asia(calendar, spec, tradeDate) is { } asia)
        {
            Touch(_asia, asia.SessionId, bar, asia.OpenMs, asia.CloseMs);
        }

        var week = RipsSessions.WeekContaining(calendar, tradeDate);
        Touch(_weeks, week.SessionId, bar, week.OpenMs, week.CloseMs);
        var bin = RipsSessions.FourHour(calendar, start);
        Touch(_fourHour, FourHourKey(bin), bar, bin.OpenMs, bin.CloseMs);
        Prune(_rth, 14);
        Prune(_asia, 14);
        Prune(_weeks, 3);
        Prune(_fourHour, 48);
    }

    /// <summary>
    /// The named levels visible at <paramref name="asOf"/>. A closed window uses the latched extreme. The developing
    /// minute, when it intersects a window that has not been trimmed out of this ledger, is included in the reading.
    /// </summary>
    public IReadOnlyList<KeyLevel> Levels(
        InstrumentSpec spec,
        ExchangeCalendar calendar,
        DateTimeOffset asOf,
        MinuteRange? developing)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(calendar);
        var levels = new List<KeyLevel>(8);
        var tradeDate = calendar.SessionFor(asOf).TradeDate;
        if (RipsSessions.PreviousRthDate(calendar, spec, tradeDate) is { } priorDate
            && RipsSessions.Rth(calendar, spec, priorDate) is { } prior
            && Covered(_rth, prior.SessionId, asOf, prior.Close) is { } rth)
        {
            levels.Add(new KeyLevel(RipsLevelNames.Pdh, rth.High, IsHigh: true, prior.SessionId, prior.CloseMs));
            levels.Add(new KeyLevel(RipsLevelNames.Pdl, rth.Low, IsHigh: false, prior.SessionId, prior.CloseMs));
        }

        if (RipsSessions.Asia(calendar, spec, tradeDate) is { } asia
            && Covered(_asia, asia.SessionId, asOf, asia.Close, developing) is { } asiaExtreme)
        {
            levels.Add(new KeyLevel(RipsLevelNames.AsiaHigh, asiaExtreme.High, IsHigh: true, asia.SessionId, asia.CloseMs));
            levels.Add(new KeyLevel(RipsLevelNames.AsiaLow, asiaExtreme.Low, IsHigh: false, asia.SessionId, asia.CloseMs));
        }

        if (RipsSessions.Rth(calendar, spec, tradeDate) is { } today && asOf >= today.Open
            && Reading(_rth, today.SessionId, today.OpenMs, today.CloseMs, developing) is { } open)
        {
            levels.Add(new KeyLevel(RipsLevelNames.DailyOpen, open.OpenPrice, IsHigh: false, today.SessionId, open.OpenStart));
        }

        var bin = RipsSessions.FourHour(calendar, asOf);
        if (Reading(_fourHour, FourHourKey(bin), bin.OpenMs, bin.CloseMs, developing) is { } fourHour)
        {
            levels.Add(new KeyLevel(RipsLevelNames.FourHourMid, RipsLevels.Mid(fourHour.High, fourHour.Low), IsHigh: false, bin.SessionId, fourHour.LastMs));
        }

        var week = RipsSessions.PriorWeek(calendar, tradeDate);
        if (Covered(_weeks, week.SessionId, asOf, week.Close) is { } covered)
        {
            levels.Add(new KeyLevel(RipsLevelNames.PriorWeekHigh, covered.High, IsHigh: true, week.SessionId, week.CloseMs));
            levels.Add(new KeyLevel(RipsLevelNames.PriorWeekMid, RipsLevels.Mid(covered.High, covered.Low), IsHigh: false, week.SessionId, week.CloseMs));
        }

        return levels;
    }

    private static void Touch(Dictionary<string, Extreme> windows, string key, MinuteRange bar, long openMs, long closeMs)
    {
        if (bar.EndMs <= openMs || bar.StartMs >= closeMs)
        {
            return;
        }

        if (!windows.TryGetValue(key, out var extreme))
        {
            extreme = new Extreme(openMs, closeMs);
            windows[key] = extreme;
        }

        extreme.Add(bar);
    }

    /// <summary>A finished window whose minutes cover both its open and its close (the same rule as <c>Measure</c>).</summary>
    private static Extreme? Covered(Dictionary<string, Extreme> windows, string key, DateTimeOffset asOf, DateTimeOffset close, MinuteRange? developing = null)
    {
        if (asOf < close || !windows.TryGetValue(key, out var extreme))
        {
            return null;
        }

        var reading = extreme;
        if (developing is { } bar
            && bar.EndMs > extreme.OpenMs
            && bar.StartMs < extreme.CloseMs
            && bar.High >= bar.Low)
        {
            reading = WithBar(extreme, bar);
        }

        return reading.CoversOpen && reading.CoversClose ? reading : null;
    }

    private static Extreme? Reading(Dictionary<string, Extreme> windows, string key, long openMs, long closeMs, MinuteRange? developing)
    {
        windows.TryGetValue(key, out var stored);
        if (developing is not { } bar || bar.EndMs <= openMs || bar.StartMs >= closeMs || bar.High < bar.Low)
        {
            return stored;
        }

        var copy = stored?.Copy() ?? new Extreme(openMs, closeMs);
        copy.Add(bar);
        return copy;
    }

    private static Extreme WithBar(Extreme stored, MinuteRange bar)
    {
        var copy = stored.Copy();
        copy.Add(bar);
        return copy;
    }

    private static string FourHourKey(SessionWindow bin) => bin.SessionId + ":" + bin.OpenMs.ToString(System.Globalization.CultureInfo.InvariantCulture);

    private static void Prune(Dictionary<string, Extreme> windows, int keep)
    {
        while (windows.Count > keep)
        {
            string? oldest = null;
            var oldestClose = long.MaxValue;
            foreach (var (key, extreme) in windows)
            {
                if (extreme.CloseMs < oldestClose)
                {
                    oldestClose = extreme.CloseMs;
                    oldest = key;
                }
            }

            if (oldest is null)
            {
                return;
            }

            windows.Remove(oldest);
        }
    }

    private sealed class Extreme(long openMs, long closeMs)
    {
        public long OpenMs { get; } = openMs;

        public long CloseMs { get; } = closeMs;

        public long High { get; private set; }

        public long Low { get; private set; }

        public long OpenPrice { get; private set; }

        public long OpenStart { get; private set; } = long.MaxValue;

        public long LastMs { get; private set; }

        public bool CoversOpen { get; private set; }

        public bool CoversClose { get; private set; }

        private bool _any;

        public void Add(MinuteRange bar)
        {
            if (!_any)
            {
                High = bar.High;
                Low = bar.Low;
                _any = true;
            }
            else
            {
                High = Math.Max(High, bar.High);
                Low = Math.Min(Low, bar.Low);
            }

            if (bar.StartMs < OpenStart)
            {
                OpenStart = bar.StartMs;
                OpenPrice = bar.Open;
            }

            if (bar.StartMs <= OpenMs && bar.EndMs > OpenMs)
            {
                CoversOpen = true;
            }

            if (bar.StartMs < CloseMs && bar.EndMs >= CloseMs)
            {
                CoversClose = true;
            }

            LastMs = Math.Max(LastMs, bar.EndMs);
        }

        public Extreme Copy()
        {
            var copy = new Extreme(OpenMs, CloseMs)
            {
                High = High,
                Low = Low,
                OpenPrice = OpenPrice,
                OpenStart = OpenStart,
                LastMs = LastMs,
                CoversOpen = CoversOpen,
                CoversClose = CoversClose,
                _any = _any,
            };
            return copy;
        }
    }
}
