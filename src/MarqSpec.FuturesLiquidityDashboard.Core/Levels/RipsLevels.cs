using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Levels;

/// <summary>One minute bar's range, in ticks. <see cref="EndMs"/> is exclusive.</summary>
public readonly record struct MinuteRange(long StartMs, long EndMs, long Open, long High, long Low);

/// <summary>Stable labels for the RIPS named levels (REQUIREMENTS.md FR-63).</summary>
public static class RipsLevelNames
{
    public const string Pdh = "PDH";
    public const string Pdl = "PDL";
    public const string AsiaHigh = "Asia high";
    public const string AsiaLow = "Asia low";
    public const string DailyOpen = "daily open";
    public const string FourHourMid = "4h mid";
    public const string PriorWeekHigh = "prior week high";
    public const string PriorWeekMid = "prior week mid";
}

/// <summary>
/// Builds the RIPS named levels from retained minute bars (REQUIREMENTS.md FR-63, ARCHITECTURE.md D-35). A high or low is
/// omitted unless the bars cover that window's open and close, so a short warmup cannot invent the extreme.
/// Daily open needs only the first minute at or after the RTH open. The 4-hour mid may still be developing.
/// </summary>
public static class RipsLevels
{
    public static IReadOnlyList<KeyLevel> FromMinuteBars(
        InstrumentSpec spec,
        ExchangeCalendar calendar,
        IReadOnlyList<MinuteRange> bars,
        DateTimeOffset asOf)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(calendar);
        ArgumentNullException.ThrowIfNull(bars);
        var levels = new List<KeyLevel>(8);
        var tradeDate = calendar.SessionFor(asOf).TradeDate;
        if (RipsSessions.PreviousRthDate(calendar, spec, tradeDate) is { } prior && RipsSessions.Rth(calendar, spec, prior) is { } rth)
        {
            AddExtremes(levels, bars, rth, RipsLevelNames.Pdh, RipsLevelNames.Pdl, requireCover: true);
        }

        if (RipsSessions.Asia(calendar, spec, tradeDate) is { } asia)
        {
            AddExtremes(levels, bars, asia, RipsLevelNames.AsiaHigh, RipsLevelNames.AsiaLow, requireCover: true);
        }

        if (RipsSessions.Rth(calendar, spec, tradeDate) is { } today && asOf >= today.Open)
        {
            MinuteRange? first = null;
            foreach (var bar in bars)
            {
                if (bar.StartMs >= today.OpenMs && bar.StartMs < today.CloseMs && (first is null || bar.StartMs < first.Value.StartMs))
                {
                    first = bar;
                }
            }

            if (first is { } openBar)
            {
                levels.Add(new KeyLevel(RipsLevelNames.DailyOpen, openBar.Open, IsHigh: false, today.SessionId, openBar.StartMs));
            }
        }

        var bin = RipsSessions.FourHour(calendar, asOf);
        if (Measure(bars, bin.OpenMs, bin.CloseMs, requireCover: false) is { } fourHour)
        {
            levels.Add(new KeyLevel(RipsLevelNames.FourHourMid, Mid(fourHour.High, fourHour.Low), IsHigh: false, bin.SessionId, fourHour.LastMs));
        }

        var week = RipsSessions.PriorWeek(calendar, tradeDate);
        if (Measure(bars, week.OpenMs, week.CloseMs, requireCover: true) is { } covered)
        {
            levels.Add(new KeyLevel(RipsLevelNames.PriorWeekHigh, covered.High, IsHigh: true, week.SessionId, week.CloseMs));
            levels.Add(new KeyLevel(RipsLevelNames.PriorWeekMid, Mid(covered.High, covered.Low), IsHigh: false, week.SessionId, week.CloseMs));
        }

        return levels;
    }

    private static void AddExtremes(
        List<KeyLevel> levels,
        IReadOnlyList<MinuteRange> bars,
        SessionWindow window,
        string highName,
        string lowName,
        bool requireCover)
    {
        if (Measure(bars, window.OpenMs, window.CloseMs, requireCover) is not { } span)
        {
            return;
        }

        levels.Add(new KeyLevel(highName, span.High, IsHigh: true, window.SessionId, window.CloseMs));
        levels.Add(new KeyLevel(lowName, span.Low, IsHigh: false, window.SessionId, window.CloseMs));
    }

    private readonly record struct Span(long High, long Low, long LastMs);

    private static Span? Measure(IReadOnlyList<MinuteRange> bars, long openMs, long closeMs, bool requireCover)
    {
        long? high = null;
        long? low = null;
        long? last = null;
        var coversOpen = false;
        var coversClose = false;
        foreach (var bar in bars)
        {
            if (bar.EndMs <= openMs || bar.StartMs >= closeMs || bar.High < bar.Low)
            {
                continue;
            }

            high = high is { } seenHigh ? Math.Max(seenHigh, bar.High) : bar.High;
            low = low is { } seenLow ? Math.Min(seenLow, bar.Low) : bar.Low;
            var end = Math.Min(bar.EndMs, closeMs);
            last = last is { } seen ? Math.Max(seen, end) : end;
            if (bar.StartMs <= openMs && bar.EndMs > openMs)
            {
                coversOpen = true;
            }

            if (bar.StartMs < closeMs && bar.EndMs >= closeMs)
            {
                coversClose = true;
            }
        }

        if (high is not { } h || low is not { } l || last is not { } at)
        {
            return null;
        }

        if (requireCover && !(coversOpen && coversClose))
        {
            return null;
        }

        return new Span(h, l, at);
    }

    /// <summary>Integer midpoint, rounding toward the lower tick when the sum is odd.</summary>
    public static long Mid(long high, long low) => (high + low) / 2;
}
