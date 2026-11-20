using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Sessions;

// reference: REQUIREMENTS.md FR-15 (CME Globex: Sunday 17:00 CT to Friday 16:00 CT, daily 16:00–17:00 CT break)
public sealed class ExchangeCalendarTests
{
    private readonly ExchangeCalendar _calendar = TestData.Calendar();

    [Fact]
    public void SessionFor_ShouldReturnTheTradeDateWithItsOpenAndClose_WhenInsideRegularHours()
    {
        var session = _calendar.SessionFor(TestData.Epoch);

        session.Id.Should().Be("2026-11-10");
        session.Open.Should().Be(new DateTimeOffset(2026, 11, 9, 23, 0, 0, TimeSpan.Zero));
        session.Close.Should().Be(new DateTimeOffset(2026, 11, 10, 22, 0, 0, TimeSpan.Zero));
    }

    [Fact]
    public void SessionFor_ShouldStartTheNextTradeDate_WhenTheClockReachesSeventeenHundredCentral()
    {
        var session = _calendar.SessionFor(Utc(2026, 11, 10, 23, 0));

        session.Id.Should().Be("2026-11-11");
    }

    [Theory]
    [InlineData(2026, 11, 10, 14, 0, true)]   // Tue 08:00 CT
    [InlineData(2026, 11, 10, 21, 59, true)]  // Tue 15:59 CT
    [InlineData(2026, 11, 10, 22, 0, false)]  // Tue 16:00 CT: the close is exclusive
    [InlineData(2026, 11, 10, 22, 30, false)] // Tue 16:30 CT: daily break
    [InlineData(2026, 11, 10, 23, 0, true)]   // Tue 17:00 CT: reopen
    [InlineData(2026, 11, 13, 21, 59, true)]  // Fri 15:59 CT
    [InlineData(2026, 11, 13, 22, 0, false)]  // Fri 16:00 CT: weekly close
    [InlineData(2026, 11, 14, 18, 0, false)]  // Sat 12:00 CT
    [InlineData(2026, 11, 15, 22, 59, false)] // Sun 16:59 CT
    [InlineData(2026, 11, 15, 23, 0, true)]   // Sun 17:00 CT: weekly open
    public void IsOpen_ShouldFollowTheGlobexSchedule_WhenGivenAnInstant(int year, int month, int day, int hour, int minute, bool open)
    {
        _calendar.IsOpen(Utc(year, month, day, hour, minute)).Should().Be(open);
    }

    [Theory]
    [InlineData(2026, 11, 14, 18, 0)] // Saturday
    [InlineData(2026, 11, 15, 10, 0)] // Sunday before the open
    [InlineData(2026, 11, 15, 23, 0)] // Sunday open
    public void SessionFor_ShouldMapTheWeekendToMondaysSession_WhenTheExchangeIsClosedOrJustOpening(int year, int month, int day, int hour, int minute)
    {
        var session = _calendar.SessionFor(Utc(year, month, day, hour, minute));

        session.Id.Should().Be("2026-11-16");
        session.Open.Should().Be(new DateTimeOffset(2026, 11, 15, 23, 0, 0, TimeSpan.Zero));
    }

    [Fact]
    public void SessionFor_ShouldReturnTheNextSession_WhenTheInstantIsInTheDailyBreak()
    {
        _calendar.SessionFor(Utc(2026, 11, 10, 22, 30)).Id.Should().Be("2026-11-11");
    }

    [Fact]
    public void SessionFor_ShouldReturnMondaysSession_WhenTheInstantIsAfterTheFridayClose()
    {
        _calendar.SessionFor(Utc(2026, 11, 13, 22, 30)).Id.Should().Be("2026-11-16");
    }

    [Fact]
    public void ForTradeDate_ShouldOpenTheDayBefore_WhenGivenAMonday()
    {
        var session = _calendar.ForTradeDate(new DateOnly(2026, 11, 16));

        (session.Open, session.Close).Should().Be((Utc(2026, 11, 15, 23, 0), Utc(2026, 11, 16, 22, 0)));
    }

    [Fact]
    public void ToCentral_ShouldConvertToTheCentralWallTime_WhenGivenAUtcInstant()
    {
        var central = _calendar.ToCentral(TestData.Epoch);

        (central.Hour, central.Offset).Should().Be((8, TimeSpan.FromHours(-6)));
    }

    // reference: ARCHITECTURE.md D-68 (warmup counts the minutes the exchange was open, not wall-clock hours)
    [Fact]
    public void OpenMinutesBack_ShouldGoBackThatManyMinutes_WhenTheSessionWasOpenThroughout()
    {
        var (from, covered) = _calendar.OpenMinutesBack(TestData.Epoch, 60, TestData.Epoch.AddHours(-24));

        from.Should().Be(TestData.Epoch.AddMinutes(-60));
        covered.Should().BeTrue();
    }

    [Fact]
    public void OpenMinutesBack_ShouldSkipTheDailyBreak_WhenTheWindowReachesThePreviousSession()
    {
        // Tue 08:00 CT: 900 open minutes back to Mon 17:00 CT, then 100 more before the Mon 16:00 CT close.
        var (from, covered) = _calendar.OpenMinutesBack(TestData.Epoch, 1_000, TestData.Epoch.AddHours(-24));

        from.Should().Be(Utc(2026, 11, 9, 20, 20), "Mon 14:20 CT leaves 1,000 open minutes before Tue 08:00 CT");
        covered.Should().BeTrue();
    }

    [Fact]
    public void OpenMinutesBack_ShouldStopAtTheFloorAndSaySo_WhenTooFewOpenMinutesAreAfterIt()
    {
        // Sun 18:00 CT: one open hour since the weekly open; the Friday session is past the 24 h floor.
        var end = Utc(2026, 11, 16, 0, 0);
        var floor = end.AddHours(-24);

        var (from, covered) = _calendar.OpenMinutesBack(end, 1_000, floor);

        from.Should().Be(floor);
        covered.Should().BeFalse();
    }

    [Fact]
    public void OpenMinutesBack_ShouldBeCovered_WhenTheOpenMinutesExactlyFillTheSpanToTheFloor()
    {
        var floor = TestData.Epoch.AddMinutes(-60);

        var (from, covered) = _calendar.OpenMinutesBack(TestData.Epoch, 60, floor);

        (from, covered).Should().Be((floor, true));
    }

    [Fact]
    public void OpenMinutesBack_ShouldReturnTheEnd_WhenNoMinutesAreNeeded()
    {
        _calendar.OpenMinutesBack(TestData.Epoch, 0, TestData.Epoch.AddHours(-24)).Should().Be((TestData.Epoch, true));
    }

    private static DateTimeOffset Utc(int year, int month, int day, int hour, int minute) =>
        new(year, month, day, hour, minute, 0, TimeSpan.Zero);
}
