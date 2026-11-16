using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Levels;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Levels;

// reference: REQUIREMENTS.md FR-63; ARCHITECTURE.md D-35
public sealed class RipsLevelsTests
{
    private static readonly ExchangeCalendar Calendar = TestData.Calendar();

    [Fact]
    public void FromMinuteBars_ShouldNameTheCoveredWindows_WhenRthAsiaAndTheFourHourBinAreKnown()
    {
        var bars = new[]
        {
            Bar(Utc(2026, 11, 9, 14, 30), 90, 92),
            Bar(Utc(2026, 11, 9, 21, 14), 108, 110),
            Bar(Utc(2026, 11, 9, 23, 0), 70, 72),
            Bar(Utc(2026, 11, 10, 7, 59), 78, 80),
            Bar(Utc(2026, 11, 10, 10, 0), 50, 51),
            Bar(Utc(2026, 11, 10, 14, 30), 95, 96),
            Bar(Utc(2026, 11, 10, 14, 40), 104, 105),
        };

        var levels = RipsLevels.FromMinuteBars(InstrumentCatalog.MES, Calendar, bars, Utc(2026, 11, 10, 14, 40));

        Level(levels, RipsLevelNames.Pdh).PriceTicks.Should().Be(110);
        Level(levels, RipsLevelNames.Pdl).PriceTicks.Should().Be(90);
        Level(levels, RipsLevelNames.Pdh).SessionId.Should().Be("2026-11-09");
        Level(levels, RipsLevelNames.AsiaHigh).PriceTicks.Should().Be(80);
        Level(levels, RipsLevelNames.AsiaLow).PriceTicks.Should().Be(70);
        Level(levels, RipsLevelNames.AsiaHigh).SessionId.Should().Be("2026-11-10");
        Level(levels, RipsLevelNames.DailyOpen).PriceTicks.Should().Be(95);
        Level(levels, RipsLevelNames.DailyOpen).AsOfMs.Should().Be(Utc(2026, 11, 10, 14, 30).ToUnixTimeMilliseconds());
        Level(levels, RipsLevelNames.FourHourMid).PriceTicks.Should().Be(100);
        levels.Should().NotContain(level => level.Name == RipsLevelNames.PriorWeekHigh);
    }

    [Fact]
    public void FromMinuteBars_ShouldOmitAWindow_WhenTheBarsDoNotCoverBothEnds()
    {
        var bars = new[] { Bar(Utc(2026, 11, 9, 18, 0), 100, 101) };

        var levels = RipsLevels.FromMinuteBars(InstrumentCatalog.MES, Calendar, bars, Utc(2026, 11, 10, 15, 0));

        levels.Should().NotContain(level =>
            level.Name == RipsLevelNames.Pdh || level.Name == RipsLevelNames.Pdl || level.Name == RipsLevelNames.AsiaHigh);
    }

    [Fact]
    public void FromMinuteBars_ShouldIncludeThePriorWeek_WhenBarsCoverItsOpenAndClose()
    {
        var week = RipsSessions.PriorWeek(Calendar, new DateOnly(2026, 11, 13));
        var bars = new[]
        {
            Bar(week.Open, 200, 210),
            Bar(week.Close.AddMinutes(-1), 240, 260),
        };

        var levels = RipsLevels.FromMinuteBars(InstrumentCatalog.MES, Calendar, bars, Utc(2026, 11, 13, 15, 0));

        Level(levels, RipsLevelNames.PriorWeekHigh).PriceTicks.Should().Be(260);
        Level(levels, RipsLevelNames.PriorWeekMid).PriceTicks.Should().Be(RipsLevels.Mid(260, 200));
        Level(levels, RipsLevelNames.PriorWeekHigh).SessionId.Should().Be("2026-11-06");
        Level(levels, RipsLevelNames.PriorWeekHigh).AsOfMs.Should().Be(week.CloseMs);
    }

    [Fact]
    public void FromMinuteBars_ShouldOmitThePriorWeek_WhenOnlyTheEndWasRetained()
    {
        var week = RipsSessions.PriorWeek(Calendar, new DateOnly(2026, 11, 13));
        var bars = new[] { Bar(week.Close.AddMinutes(-1), 240, 260) };

        var levels = RipsLevels.FromMinuteBars(InstrumentCatalog.MES, Calendar, bars, Utc(2026, 11, 13, 15, 0));

        levels.Should().NotContain(level => level.Name == RipsLevelNames.PriorWeekHigh);
    }

    private static Core.OrderFlow.KeyLevel Level(IReadOnlyList<Core.OrderFlow.KeyLevel> levels, string name) =>
        levels.Should().ContainSingle(level => level.Name == name).Subject;

    private static MinuteRange Bar(DateTimeOffset start, long low, long high) =>
        new(start.ToUnixTimeMilliseconds(), start.AddMinutes(1).ToUnixTimeMilliseconds(), low, high, low);

    private static DateTimeOffset Utc(int year, int month, int day, int hour, int minute) =>
        new(year, month, day, hour, minute, 0, TimeSpan.Zero);
}
