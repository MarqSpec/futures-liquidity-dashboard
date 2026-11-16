namespace MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

/// <summary>
/// One named window on the exchange clock. <see cref="Open"/> and <see cref="Close"/> are UTC instants; the hours
/// that produced them are America/Chicago wall times (ARCHITECTURE.md D-35).
/// </summary>
public sealed record SessionWindow(string Name, string SessionId, DateTimeOffset Open, DateTimeOffset Close)
{
    public bool Contains(DateTimeOffset instant) => instant >= Open && instant < Close;

    public long OpenMs => Open.ToUnixTimeMilliseconds();

    public long CloseMs => Close.ToUnixTimeMilliseconds();
}

/// <summary>Which RTH and Asia clocks a product uses. A product outside these three families has neither window.</summary>
public enum RipsFamily
{
    None,
    EquityIndex,
    Energy,
    Metals,
}

/// <summary>
/// RTH, Asia and the prior Globex week for RIPS named levels (REQUIREMENTS.md FR-63, ARCHITECTURE.md D-35). Hours are
/// America/Chicago wall times on <see cref="ExchangeCalendar"/>, so CST and CDT are the zone's offset and never a
/// fixed UTC shift. Globex session identity stays on <see cref="ExchangeCalendar"/> and still ignores holidays.
/// </summary>
public static class RipsSessions
{
    private readonly record struct FamilyClock(TimeOnly RthOpen, TimeOnly RthClose, TimeOnly EarlyClose, TimeOnly AsiaOpen, TimeOnly AsiaClose);

    // reference: ARCHITECTURE.md D-35 — each family names its own exchange-local hours
    private static readonly FamilyClock Equity = new(new TimeOnly(8, 30), new TimeOnly(15, 15), new TimeOnly(12, 15), new TimeOnly(17, 0), new TimeOnly(2, 0));
    private static readonly FamilyClock Energy = new(new TimeOnly(8, 0), new TimeOnly(13, 30), new TimeOnly(12, 30), new TimeOnly(17, 0), new TimeOnly(2, 0));
    private static readonly FamilyClock Metals = new(new TimeOnly(7, 20), new TimeOnly(12, 30), new TimeOnly(11, 30), new TimeOnly(17, 0), new TimeOnly(2, 0));

    /// <summary>Full RTH and Asia closures. A date not listed is a normal window. This is an explicit list, not a feed.</summary>
    private static readonly HashSet<DateOnly> Closed =
    [
        new(2025, 1, 1), new(2025, 1, 20), new(2025, 2, 17), new(2025, 4, 18), new(2025, 5, 26),
        new(2025, 6, 19), new(2025, 7, 4), new(2025, 9, 1), new(2025, 11, 27), new(2025, 12, 25),
        new(2026, 1, 1), new(2026, 1, 19), new(2026, 2, 16), new(2026, 4, 3), new(2026, 5, 25),
        new(2026, 6, 19), new(2026, 9, 7), new(2026, 11, 26), new(2026, 12, 25),
        new(2027, 1, 1), new(2027, 1, 18), new(2027, 2, 15), new(2027, 3, 26), new(2027, 5, 31),
        new(2027, 6, 18), new(2027, 7, 5), new(2027, 9, 6), new(2027, 11, 25), new(2027, 12, 24),
    ];

    /// <summary>RTH ends at the family's early close. Asia is unchanged.</summary>
    private static readonly HashSet<DateOnly> Early =
    [
        new(2025, 11, 28), new(2025, 12, 24),
        new(2026, 7, 3), new(2026, 11, 27), new(2026, 12, 24),
        new(2027, 11, 26),
    ];

    public static RipsFamily FamilyOf(InstrumentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        return spec.Sector switch
        {
            InstrumentCatalog.EquitySector => RipsFamily.EquityIndex,
            InstrumentCatalog.EnergySector => RipsFamily.Energy,
            InstrumentCatalog.MetalsSector => RipsFamily.Metals,
            _ => RipsFamily.None,
        };
    }

    public static bool IsClosed(DateOnly tradeDate) =>
        tradeDate.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday || Closed.Contains(tradeDate);

    public static bool IsEarlyClose(DateOnly tradeDate) => Early.Contains(tradeDate);

    /// <summary>The trade date's RTH, or null when the product has none or the date is closed.</summary>
    public static SessionWindow? Rth(ExchangeCalendar calendar, InstrumentSpec spec, DateOnly tradeDate)
    {
        ArgumentNullException.ThrowIfNull(calendar);
        if (Clock(spec) is not { } clock || IsClosed(tradeDate))
        {
            return null;
        }

        var close = IsEarlyClose(tradeDate) ? clock.EarlyClose : clock.RthClose;
        return Window(calendar, "RTH", tradeDate, tradeDate, clock.RthOpen, tradeDate, close);
    }

    /// <summary>
    /// Asia for <paramref name="tradeDate"/>: the previous evening's open through the morning close, both in
    /// America/Chicago. Null when the product has no Asia window or the date is a full closure.
    /// </summary>
    public static SessionWindow? Asia(ExchangeCalendar calendar, InstrumentSpec spec, DateOnly tradeDate)
    {
        ArgumentNullException.ThrowIfNull(calendar);
        if (Clock(spec) is not { } clock || IsClosed(tradeDate))
        {
            return null;
        }

        return Window(calendar, "Asia", tradeDate, tradeDate.AddDays(-1), clock.AsiaOpen, tradeDate, clock.AsiaClose);
    }

    /// <summary>The previous open RTH date, skipping weekends and full closures, or null within ten days.</summary>
    public static DateOnly? PreviousRthDate(ExchangeCalendar calendar, InstrumentSpec spec, DateOnly tradeDate)
    {
        for (var days = 1; days <= 10; days++)
        {
            var candidate = tradeDate.AddDays(-days);
            if (Rth(calendar, spec, candidate) is not null)
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>
    /// The Globex week that contains <paramref name="tradeDate"/>: the Monday session's Sunday 17:00 CT open through
    /// Friday 16:00 CT. The session id is that Friday.
    /// </summary>
    public static SessionWindow WeekContaining(ExchangeCalendar calendar, DateOnly tradeDate)
    {
        ArgumentNullException.ThrowIfNull(calendar);
        var monday = tradeDate.AddDays(-(((int)tradeDate.DayOfWeek + 6) % 7));
        var friday = monday.AddDays(4);
        return new SessionWindow(
            "week",
            friday.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            calendar.ForTradeDate(monday).Open,
            calendar.ForTradeDate(friday).Close);
    }

    /// <summary>
    /// The Globex week before the week that contains <paramref name="tradeDate"/>: Sunday 17:00 CT through the
    /// following Friday 16:00 CT. The session id is that Friday's trade date.
    /// </summary>
    public static SessionWindow PriorWeek(ExchangeCalendar calendar, DateOnly tradeDate)
    {
        ArgumentNullException.ThrowIfNull(calendar);
        var monday = tradeDate.AddDays(-(((int)tradeDate.DayOfWeek + 6) % 7));
        var priorFriday = monday.AddDays(-3);
        return WeekContaining(calendar, priorFriday);
    }

    /// <summary>
    /// The 4-hour bin containing <paramref name="instant"/>, aligned to 01:00, 05:00, 09:00, 13:00, 17:00 and 21:00
    /// America/Chicago. The close is the next of those wall times, so a DST transition shortens the bin instead of
    /// shifting it by a fixed UTC offset.
    /// </summary>
    public static SessionWindow FourHour(ExchangeCalendar calendar, DateTimeOffset instant)
    {
        ArgumentNullException.ThrowIfNull(calendar);
        var localDate = DateOnly.FromDateTime(calendar.ToCentral(instant).DateTime);
        DateTimeOffset? open = null;
        foreach (var day in new[] { localDate.AddDays(-1), localDate, localDate.AddDays(1) })
        {
            foreach (var hour in new[] { 1, 5, 9, 13, 17, 21 })
            {
                var boundary = calendar.AtLocal(day, new TimeOnly(hour, 0));
                if (boundary <= instant && (open is null || boundary > open))
                {
                    open = boundary;
                }
            }
        }

        var openAt = open ?? instant;
        DateTimeOffset? close = null;
        foreach (var day in new[] { localDate.AddDays(-1), localDate, localDate.AddDays(1), localDate.AddDays(2) })
        {
            foreach (var hour in new[] { 1, 5, 9, 13, 17, 21 })
            {
                var boundary = calendar.AtLocal(day, new TimeOnly(hour, 0));
                if (boundary > openAt && (close is null || boundary < close))
                {
                    close = boundary;
                }
            }
        }

        var session = calendar.SessionFor(openAt);
        return new SessionWindow("4h", session.Id, openAt, close ?? openAt.AddHours(4));
    }

    private static FamilyClock? Clock(InstrumentSpec spec) => FamilyOf(spec) switch
    {
        RipsFamily.EquityIndex => Equity,
        RipsFamily.Energy => Energy,
        RipsFamily.Metals => Metals,
        _ => null,
    };

    private static SessionWindow Window(
        ExchangeCalendar calendar,
        string name,
        DateOnly sessionDate,
        DateOnly openDate,
        TimeOnly openClock,
        DateOnly closeDate,
        TimeOnly closeClock) =>
        new(
            name,
            sessionDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            calendar.AtLocal(openDate, openClock),
            calendar.AtLocal(closeDate, closeClock));
}
