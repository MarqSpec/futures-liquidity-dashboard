using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Sessions;

// reference: REQUIREMENTS.md FR-63; ARCHITECTURE.md D-35
public sealed class RipsSessionsTests
{
    private static readonly ExchangeCalendar Fixed = TestData.Calendar();

    [Fact]
    public void Rth_ShouldUseEachFamilysExchangeClock_WhenTheDateIsAFullSession()
    {
        var day = new DateOnly(2026, 11, 10);

        var equity = RipsSessions.Rth(Fixed, InstrumentCatalog.MES, day);
        var energy = RipsSessions.Rth(Fixed, InstrumentCatalog.MCL, day);
        var metals = RipsSessions.Rth(Fixed, InstrumentCatalog.MGC, day);

        equity!.Open.Should().Be(new DateTimeOffset(2026, 11, 10, 14, 30, 0, TimeSpan.Zero));
        equity.Close.Should().Be(new DateTimeOffset(2026, 11, 10, 21, 15, 0, TimeSpan.Zero));
        equity.SessionId.Should().Be("2026-11-10");
        energy!.Open.Should().Be(new DateTimeOffset(2026, 11, 10, 14, 0, 0, TimeSpan.Zero));
        energy.Close.Should().Be(new DateTimeOffset(2026, 11, 10, 19, 30, 0, TimeSpan.Zero));
        metals!.Open.Should().Be(new DateTimeOffset(2026, 11, 10, 13, 20, 0, TimeSpan.Zero));
        metals.Close.Should().Be(new DateTimeOffset(2026, 11, 10, 18, 30, 0, TimeSpan.Zero));
    }

    [Fact]
    public void Asia_ShouldRunFromThePreviousEvening_WhenTheProductHasAnAsiaWindow()
    {
        var asia = RipsSessions.Asia(Fixed, InstrumentCatalog.MES, new DateOnly(2026, 11, 10));

        asia!.Open.Should().Be(new DateTimeOffset(2026, 11, 9, 23, 0, 0, TimeSpan.Zero));
        asia.Close.Should().Be(new DateTimeOffset(2026, 11, 10, 8, 0, 0, TimeSpan.Zero));
        asia.SessionId.Should().Be("2026-11-10");
    }

    [Fact]
    public void Rth_ShouldEndAtTheEarlyClose_WhenTheDateIsOnTheEarlyList()
    {
        var early = RipsSessions.Rth(Fixed, InstrumentCatalog.MES, new DateOnly(2026, 11, 27));

        early!.Open.Should().Be(new DateTimeOffset(2026, 11, 27, 14, 30, 0, TimeSpan.Zero));
        early.Close.Should().Be(new DateTimeOffset(2026, 11, 27, 18, 15, 0, TimeSpan.Zero));
        RipsSessions.Asia(Fixed, InstrumentCatalog.MES, new DateOnly(2026, 11, 27)).Should().NotBeNull();
    }

    [Fact]
    public void Rth_ShouldBeAbsent_WhenTheDateIsAFullClosure()
    {
        RipsSessions.Rth(Fixed, InstrumentCatalog.MES, new DateOnly(2026, 11, 26)).Should().BeNull();
        RipsSessions.Asia(Fixed, InstrumentCatalog.MCL, new DateOnly(2026, 11, 26)).Should().BeNull();
        RipsSessions.PreviousRthDate(Fixed, InstrumentCatalog.MES, new DateOnly(2026, 11, 27)).Should().Be(new DateOnly(2026, 11, 25));
    }

    [Fact]
    public void Rth_ShouldBeAbsent_WhenTheProductHasNoFamily()
    {
        var rates = InstrumentCatalog.All.First(spec => spec.Sector == InstrumentCatalog.RatesSector);
        RipsSessions.Rth(Fixed, rates, new DateOnly(2026, 11, 10)).Should().BeNull();
        RipsSessions.FamilyOf(rates).Should().Be(RipsFamily.None);
    }

    [Fact]
    public void Rth_ShouldFollowDaylightSaving_WhenTheClockChanges()
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById("America/Chicago");
        var calendar = new ExchangeCalendar(zone);
        var winter = RipsSessions.Rth(calendar, InstrumentCatalog.MES, new DateOnly(2026, 3, 6));
        var summer = RipsSessions.Rth(calendar, InstrumentCatalog.MES, new DateOnly(2026, 3, 9));

        winter!.Open.Should().Be(new DateTimeOffset(2026, 3, 6, 14, 30, 0, TimeSpan.Zero));
        summer!.Open.Should().Be(new DateTimeOffset(2026, 3, 9, 13, 30, 0, TimeSpan.Zero));
        winter.Open.Offset.Should().Be(TimeSpan.Zero);
        (summer.Open - winter.Open).Should().NotBe(TimeSpan.FromDays(3));
    }

    [Fact]
    public void PriorWeek_ShouldBeThePreviousGlobexWeek_WhenTheTradeDateIsAFriday()
    {
        var week = RipsSessions.PriorWeek(Fixed, new DateOnly(2026, 11, 13));

        week.SessionId.Should().Be("2026-11-06");
        week.Open.Should().Be(new DateTimeOffset(2026, 11, 1, 23, 0, 0, TimeSpan.Zero));
        week.Close.Should().Be(new DateTimeOffset(2026, 11, 6, 22, 0, 0, TimeSpan.Zero));
    }

    [Fact]
    public void FourHour_ShouldStayOnTheChicagoClock_WhenTheInstantIsInsideABin()
    {
        var at = new DateTimeOffset(2026, 11, 10, 14, 40, 0, TimeSpan.Zero);
        var bin = RipsSessions.FourHour(Fixed, at);

        bin.Open.Should().Be(new DateTimeOffset(2026, 11, 10, 11, 0, 0, TimeSpan.Zero));
        bin.Close.Should().Be(new DateTimeOffset(2026, 11, 10, 15, 0, 0, TimeSpan.Zero));
        bin.SessionId.Should().Be("2026-11-10");
    }
}
