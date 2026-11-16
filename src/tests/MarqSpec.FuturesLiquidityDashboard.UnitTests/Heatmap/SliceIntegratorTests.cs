using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Heatmap;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Heatmap;

// reference: REQUIREMENTS.md FR-1, FR-11, FR-12
public sealed class SliceIntegratorTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Advance_ShouldCreditRestingQuantityOverTheKnownMilliseconds_WhenASliceCloses()
    {
        var book = SmallBook();
        var integrator = new SliceIntegrator(1_000);
        integrator.Advance(T0, book);

        var closed = integrator.Advance(T0 + 1_000, book);

        var column = closed.Should().ContainSingle().Subject;
        (column.StartMs, column.DurationMs).Should().Be((T0, 1_000));
        column.Cells.Select(c => c.PriceTicks).Should().Equal(98, 99, 100, 101);
        column.Cells.Single(c => c.PriceTicks == 99).Should().Be(new HeatCell(99, 5_000, 0, 1_000));
        column.Cells.Single(c => c.PriceTicks == 99).BidTimeWeighted.Should().Be(5);
    }

    [Fact]
    public void Advance_ShouldBuildABoundedNumberOfSlices_WhenTimeJumpsFarAhead()
    {
        var book = SmallBook();
        var integrator = new SliceIntegrator(1_000);
        integrator.Advance(T0, book);

        var closed = integrator.Advance(T0 + (30L * 86_400_000), book);

        closed.Count.Should().BeLessThanOrEqualTo(SliceIntegrator.MaxCatchUpSlices + 1);
        closed[^1].StartMs.Should().Be(T0 + (30L * 86_400_000) - 1_000);
    }

    [Fact]
    public void Advance_ShouldBuildEverySlice_WhenTheGapIsExactlyTheCatchUpCap()
    {
        var book = SmallBook();
        var integrator = new SliceIntegrator(1_000);
        integrator.Advance(T0, book);

        var closed = integrator.Advance(T0 + (SliceIntegrator.MaxCatchUpSlices * 1_000L), book);

        SliceIntegrator.MaxCatchUpSlices.Should().Be(7_200, "ARCHITECTURE.md documents two hours of 1 s slices");
        closed.Should().HaveCount(SliceIntegrator.MaxCatchUpSlices);
        closed[0].StartMs.Should().Be(T0);
        closed.Select(c => c.StartMs).Should().BeInAscendingOrder().And.OnlyHaveUniqueItems();
    }

    [Fact]
    public void Advance_ShouldSkipTheOldestSlices_WhenTheGapIsOneSlicePastTheCap()
    {
        var book = SmallBook();
        var integrator = new SliceIntegrator(1_000);
        integrator.Advance(T0, book);
        var now = T0 + ((SliceIntegrator.MaxCatchUpSlices + 1) * 1_000L);

        var closed = integrator.Advance(now, book);

        closed.Should().HaveCount(SliceIntegrator.MaxCatchUpSlices + 1);
        closed[0].StartMs.Should().Be(T0);
        closed[1].StartMs.Should().Be(now - (SliceIntegrator.MaxCatchUpSlices * 1_000L));
        closed[^1].StartMs.Should().Be(now - 1_000);
    }

    [Fact]
    public void Advance_ShouldCreditNoKnownTime_WhenACoveredTickIsUnknown()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10), new BookLevel(99, 10), new BookLevel(98, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        var integrator = new SliceIntegrator(1_000);
        integrator.Advance(T0, book);
        book.Apply(BookSide.Bid, 97, 50);
        book.Apply(BookSide.Bid, 100, 0);

        var column = integrator.Advance(T0 + 1_000, book).Single();

        column.Cells.Should().NotContain(c => c.PriceTicks == 97, "97 is covered but its size is unknown");
        column.Cells.Single(c => c.PriceTicks == 98).KnownMs.Should().Be(1_000);
    }

    [Fact]
    public void Advance_ShouldCreditNoKnownTime_WhenAnEmptiedSideRefillsBelowItsOldCoverage()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(
            T0,
            [new BookLevel(100, 10)],
            [new BookLevel(101, 10), new BookLevel(102, 10), new BookLevel(103, 10)],
            levelsPerSide: 3));
        var integrator = new SliceIntegrator(1_000);
        integrator.Advance(T0, book);
        book.Apply(BookSide.Bid, 96, 50);
        book.Apply(BookSide.Bid, 100, 0);
        book.Apply(BookSide.Bid, 95, 5);

        var column = integrator.Advance(T0 + 1_000, book).Single();

        column.Cells.Should().NotContain(c => c.PriceTicks == 96 || c.PriceTicks == 97);
        column.Cells.Single(c => c.PriceTicks == 95).KnownMs.Should().Be(1_000);
    }

    [Fact]
    public void Advance_ShouldCountOnlyKnownTime_WhenTheBookBecomesUnknownMidSlice()
    {
        var book = SmallBook();
        var integrator = new SliceIntegrator(1_000);
        integrator.Advance(T0, book);
        integrator.Advance(T0 + 400, book);
        book.Invalidate();

        var column = integrator.Advance(T0 + 1_000, book).Single();

        column.Cells.Should().AllSatisfy(c => c.KnownMs.Should().Be(400));
        column.Cells.Single(c => c.PriceTicks == 100).AskTimeWeighted.Should().Be(4);
    }

    [Fact]
    public void Advance_ShouldCloseAColumnWithNoCells_WhenTheBookWasUnknownForTheWholeSlice()
    {
        var integrator = new SliceIntegrator(1_000);
        integrator.Advance(T0, new OrderBook());

        integrator.Advance(T0 + 1_000, new OrderBook()).Single().Cells.Should().BeEmpty();
    }

    [Fact]
    public void Advance_ShouldIgnoreTime_WhenItDoesNotMoveForward()
    {
        var book = SmallBook();
        var integrator = new SliceIntegrator(1_000);
        integrator.Advance(T0 + 500, book);

        integrator.Advance(T0 + 100, book).Should().BeEmpty();
    }

    [Fact]
    public void Combine_ShouldAddIntegralsAndKnownTime_WhenMergingColumns()
    {
        var a = new HeatmapColumn(T0, 1_000, [new HeatCell(99, 5_000, 0, 1_000)]);
        var b = new HeatmapColumn(T0 + 1_000, 1_000, [new HeatCell(99, 1_000, 0, 500)]);

        var merged = HeatmapColumn.Combine(T0, 2_000, [a, b]);

        merged.Cells.Should().ContainSingle().Which.Should().Be(new HeatCell(99, 6_000, 0, 1_500));
        merged.Cells[0].BidTimeWeighted.Should().Be(4);
    }

    [Fact]
    public void HeatCell_ShouldHaveNoTimeWeightedValue_WhenNeverKnown()
    {
        new HeatCell(99, 0, 0, 0).BidTimeWeighted.Should().BeNull();
    }

    /// <summary>Two levels a side: bids 99 (5) and 98 (3), asks 100 (4) and 101 (2); coverage 98–101.</summary>
    private static OrderBook SmallBook()
    {
        var book = new OrderBook();
        book.ApplySnapshot(TestData.Snapshot(T0, [new BookLevel(99, 5), new BookLevel(98, 3)], [new BookLevel(100, 4), new BookLevel(101, 2)], 2));
        return book;
    }

    [Fact]
    public void Constructor_ShouldThrow_WhenTheSliceIsNotPositive()
    {
        var act = () => new SliceIntegrator(0);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}
