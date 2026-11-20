namespace MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

/// <summary>A trading session: its trade date (the session ID) and its open and close instants.</summary>
public sealed record TradingSession(DateOnly TradeDate, DateTimeOffset Open, DateTimeOffset Close)
{
    public string Id => TradeDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
}

/// <summary>
/// The CME Globex schedule ES (CME), GC (COMEX) and CL (NYMEX) share: Sunday 17:00 CT to Friday 16:00 CT with a
/// daily 16:00–17:00 CT maintenance break; a session opening at 17:00 CT belongs to the next trade date
/// (REQUIREMENTS.md FR-15). Times are held in UTC and converted through America/Chicago, so CST/CDT changes are exact.
/// Exchange holidays and early closes are not modelled on this Globex session (ARCHITECTURE.md D-5). RIPS RTH and
/// Asia windows carry their own explicit list (RipsSessions, D-35).
/// </summary>
public sealed class ExchangeCalendar
{
    private static readonly TimeSpan OpenTime = new(17, 0, 0);
    private static readonly TimeSpan CloseTime = new(16, 0, 0);

    public ExchangeCalendar(TimeZoneInfo? central = null) => Central = central ?? FindCentral();

    public TimeZoneInfo Central { get; }

    /// <summary>The session an instant belongs to; an instant in a break or a weekend maps to the next session.</summary>
    public TradingSession SessionFor(DateTimeOffset instant)
    {
        var local = TimeZoneInfo.ConvertTime(instant, Central).DateTime;
        var tradeDate = DateOnly.FromDateTime(local.TimeOfDay >= CloseTime ? local.Date.AddDays(1) : local.Date);
        tradeDate = tradeDate.DayOfWeek switch
        {
            DayOfWeek.Saturday => tradeDate.AddDays(2),
            DayOfWeek.Sunday => tradeDate.AddDays(1),
            _ => tradeDate,
        };
        return ForTradeDate(tradeDate);
    }

    public TradingSession ForTradeDate(DateOnly tradeDate)
    {
        // Monday's session opens on Sunday, which is the day before like every other trade date.
        var openDate = tradeDate.AddDays(-1);
        var open = ToUtc(openDate.ToDateTime(TimeOnly.FromTimeSpan(OpenTime)));
        var close = ToUtc(tradeDate.ToDateTime(TimeOnly.FromTimeSpan(CloseTime)));
        return new TradingSession(tradeDate, open, close);
    }

    /// <summary>True while the exchange is open (not in the daily break or the weekend).</summary>
    public bool IsOpen(DateTimeOffset instant)
    {
        var session = SessionFor(instant);
        return instant >= session.Open && instant < session.Close;
    }

    /// <summary>
    /// The latest instant from which the exchange is open for at least <paramref name="minutes"/> whole minutes up to
    /// <paramref name="end"/>, counting back minute by minute and skipping the daily break and the weekend
    /// (ARCHITECTURE.md D-68). Never earlier than <paramref name="floor"/>: when that many open minutes do not fit
    /// after it, the floor is returned and <c>Covered</c> is false.
    /// </summary>
    public (DateTimeOffset From, bool Covered) OpenMinutesBack(DateTimeOffset end, int minutes, DateTimeOffset floor)
    {
        var from = end;
        var open = 0;
        while (open < minutes)
        {
            var previous = from.AddMinutes(-1);
            if (previous < floor)
            {
                return (floor, false);
            }

            if (IsOpen(previous))
            {
                open++;
            }

            from = previous;
        }

        return (from, true);
    }

    /// <summary>The America/Chicago wall time and its UTC offset, for display (REQUIREMENTS.md FR-15, FR-26).</summary>
    public DateTimeOffset ToCentral(DateTimeOffset instant) => TimeZoneInfo.ConvertTime(instant, Central);

    /// <summary>The UTC instant of an America/Chicago wall time. The offset is the zone's, including DST.</summary>
    public DateTimeOffset AtLocal(DateOnly date, TimeOnly time) => ToUtc(date.ToDateTime(time));

    private DateTimeOffset ToUtc(DateTime centralWallTime)
    {
        var unspecified = DateTime.SpecifyKind(centralWallTime, DateTimeKind.Unspecified);
        return new DateTimeOffset(unspecified, Central.GetUtcOffset(unspecified)).ToUniversalTime();
    }

    private static TimeZoneInfo FindCentral()
    {
        foreach (var id in new[] { "America/Chicago", "Central Standard Time" })
        {
            if (TimeZoneInfo.TryFindSystemTimeZoneById(id, out var zone))
            {
                return zone;
            }
        }

        throw new TimeZoneNotFoundException("America/Chicago is not available on this host; install tzdata.");
    }
}
