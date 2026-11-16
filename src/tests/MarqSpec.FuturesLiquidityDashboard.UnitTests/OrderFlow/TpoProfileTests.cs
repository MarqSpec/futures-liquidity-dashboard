using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-51, ARCHITECTURE.md D-24
public sealed class TpoProfileTests
{
    private const long PeriodMs = 30 * 60_000;
    private static readonly long Open = TestData.SessionOpenMs;

    [Fact]
    public void Add_ShouldGiveEachRowOneLetterPerPeriod_WhenPeriodsTradeTheSameRows()
    {
        var tpo = Started();

        tpo.Add(Open, 100);
        tpo.Add(Open + 60_000, 101);   // same row (100–103), same period: still one A
        tpo.Add(Open + 120_000, 104);
        tpo.Add(Open + PeriodMs, 104);
        tpo.Add(Open + PeriodMs + 1, 108);

        tpo.Snapshot(2).Rows.Should().Equal(new TpoRow(100, "A"), new TpoRow(104, "AB"), new TpoRow(108, "B"));
    }

    [Fact]
    public void Snapshot_ShouldPickTheRowWithMostLettersAsPoc_WhenOneRowLeads()
    {
        var tpo = Started();
        tpo.Add(Open, 100);
        tpo.Add(Open, 104);
        tpo.Add(Open + PeriodMs, 104);

        tpo.Snapshot(2).PocTicks.Should().Be(104);
    }

    [Fact]
    public void Snapshot_ShouldPickTheLowerRowAsPoc_WhenRowsTie()
    {
        var tpo = Started();
        tpo.Add(Open, 104);
        tpo.Add(Open, 100);

        tpo.Snapshot(2).PocTicks.Should().Be(100);
    }

    [Fact]
    public void Snapshot_ShouldReportInteriorSinglePrints_WhenTwoOrMoreAdjacentRowsHaveOnePeriod()
    {
        var tpo = Started();
        Trade(tpo, period: 0, 100, 104, 108, 112);
        Trade(tpo, period: 1, 112, 116, 120, 124);
        Trade(tpo, period: 2, 100, 124);

        var snapshot = tpo.Snapshot(2);

        snapshot.SinglePrints.Should().Equal(
            new SinglePrintRun(104, 111, 'A', Tail: false),
            new SinglePrintRun(116, 123, 'B', Tail: false));
        snapshot.PocTicks.Should().Be(100);
    }

    [Fact]
    public void Snapshot_ShouldMarkTheRunAsATail_WhenItReachesTheProfileExtreme()
    {
        var tpo = Started();
        Trade(tpo, period: 0, 100, 104, 108);
        Trade(tpo, period: 1, 108);

        tpo.Snapshot(2).SinglePrints.Should().ContainSingle().Which.Should().Be(new SinglePrintRun(100, 107, 'A', Tail: true));
    }

    [Fact]
    public void Snapshot_ShouldNotReportASingleRow_WhenTheMinimumIsTwoRows()
    {
        var tpo = Started();
        Trade(tpo, period: 0, 100, 104, 108);
        Trade(tpo, period: 1, 100, 108);

        tpo.Snapshot(2).SinglePrints.Should().BeEmpty();
    }

    [Fact]
    public void Add_ShouldRebaseTheOpenToTheirOwnHalfHour_WhenPrintsArriveBeforeTheOpenOnAnEmptyProfile()
    {
        var tpo = Started();

        tpo.Add(Open - (45 * 60_000), 100);

        var snapshot = tpo.Snapshot(2);
        snapshot.SessionOpenMs.Should().Be(Open - PeriodMs - PeriodMs);
        snapshot.Rows.Should().Equal(new TpoRow(100, "A"));
    }

    [Fact]
    public void Add_ShouldDropAPrint_WhenItIsBeforeTheOpenAndTheProfileAlreadyHasRows()
    {
        var tpo = Started();
        tpo.Add(Open, 100);

        tpo.Add(Open - 60_000, 200);

        tpo.Snapshot(2).Rows.Should().ContainSingle();
    }

    [Fact]
    public void Add_ShouldDropAPrint_WhenItFallsBeyondTheSixtyFourthPeriod()
    {
        var tpo = Started();

        tpo.Add(Open + (64 * PeriodMs), 100);

        tpo.Snapshot(2).Rows.Should().BeEmpty();
    }

    [Fact]
    public void Reset_ShouldClearRowsAndKeepThePartialMark_WhenANewSessionStarts()
    {
        var tpo = Started();
        tpo.Add(Open, 100);

        tpo.Reset(Open + (24 * 60 * 60_000), partialSinceMs: Open + (25 * 60 * 60_000));

        var snapshot = tpo.Snapshot(2);
        snapshot.Rows.Should().BeEmpty();
        snapshot.PocTicks.Should().BeNull();
        snapshot.PartialSinceMs.Should().Be(Open + (25 * 60 * 60_000));
    }

    [Theory]
    [InlineData(0, 'A')]
    [InlineData(25, 'Z')]
    [InlineData(26, 'a')]
    [InlineData(51, 'z')]
    [InlineData(52, '?')]
    [InlineData(-1, '?')]
    public void LetterFor_ShouldMapPeriodsToTheLetterSequence_WhenGivenAnIndex(int period, char expected)
    {
        TpoProfile.LetterFor(period).Should().Be(expected);
    }

    [Theory]
    [InlineData(103, 100)]
    [InlineData(104, 104)]
    [InlineData(-1, -4)]
    public void RowOf_ShouldFloorToTheRowHeight_WhenGivenAPrice(long price, long row)
    {
        new TpoProfile(30, 4).RowOf(price).Should().Be(row);
    }

    [Fact]
    public void PeriodOf_ShouldReturnMinusOne_WhenBeforeTheOpen()
    {
        var tpo = Started();

        (tpo.PeriodOf(Open - 1), tpo.PeriodOf(Open), tpo.PeriodOf(Open + PeriodMs)).Should().Be((-1, 0, 1));
    }

    private static TpoProfile Started()
    {
        var tpo = new TpoProfile(30, 4);
        tpo.Reset(Open, partialSinceMs: null);
        return tpo;
    }

    private static void Trade(TpoProfile tpo, int period, params long[] prices)
    {
        foreach (var price in prices)
        {
            tpo.Add(Open + (period * PeriodMs), price);
        }
    }
}
