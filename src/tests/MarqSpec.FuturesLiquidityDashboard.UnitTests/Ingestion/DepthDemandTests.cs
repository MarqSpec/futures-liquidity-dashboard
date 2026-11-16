using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: REQUIREMENTS.md FR-54
public sealed class DepthDemandTests
{
    private static readonly InstrumentRoot Nq = InstrumentRoot.Parse("NQ");
    private static readonly InstrumentRoot Mnq = InstrumentRoot.Parse("MNQ");
    private static readonly InstrumentRoot SixE = InstrumentRoot.Parse("6E");
    private static readonly InstrumentRoot[] Available = [InstrumentRoot.ES, InstrumentRoot.GC, InstrumentRoot.CL, Nq, Mnq, SixE];

    [Fact]
    public void Wanted_ShouldBeThePinnedProducts_WhenNobodyWatches()
    {
        var demand = New(out _, pinned: ["ES", "gc"]);

        demand.Wanted(Available, out var limited).Should().BeEquivalentTo([InstrumentRoot.ES, InstrumentRoot.GC]);
        limited.Should().BeEmpty();
    }

    [Fact]
    public void Wanted_ShouldHoldAWatchedProductOnce_ForTwoViewers_UntilTheReleaseDelayAfterTheLast()
    {
        var demand = New(out var time, releaseDelayMs: 30_000);
        demand.Acquire(Nq);
        demand.Acquire(Nq);
        demand.Viewers(Nq).Should().Be(2);

        demand.Release(Nq);
        demand.Wanted(Available, out _).Should().Contain(Nq);
        demand.Release(Nq);
        demand.Viewers(Nq).Should().Be(0);
        time.Advance(TimeSpan.FromSeconds(29));
        demand.Wanted(Available, out _).Should().Contain(Nq, "depth lingers so flicking between products does not churn");

        time.Advance(TimeSpan.FromSeconds(1));
        demand.Wanted(Available, out _).Should().NotContain(Nq);
    }

    [Fact]
    public void Acquire_ShouldCancelALingeringRelease()
    {
        var demand = New(out var time, releaseDelayMs: 1_000);
        demand.Acquire(Nq);
        demand.Release(Nq);
        demand.Acquire(Nq);

        time.Advance(TimeSpan.FromSeconds(5));

        demand.Wanted(Available, out _).Should().Contain(Nq);
    }

    [Fact]
    public void Wanted_ShouldCutAtTheLimit_PinnedFirst_ThenByWhenFirstWanted()
    {
        var demand = New(out var time, pinned: ["ES"], max: 3);
        demand.Acquire(SixE);
        time.Advance(TimeSpan.FromMilliseconds(1));
        demand.Acquire(Nq);
        time.Advance(TimeSpan.FromMilliseconds(1));
        demand.Acquire(Mnq);

        var wanted = demand.Wanted(Available, out var limited);

        wanted.Should().BeEquivalentTo([InstrumentRoot.ES, SixE, Nq]);
        limited.Should().Equal(Mnq);
        demand.Grants(Mnq, Available).Should().BeFalse();
    }

    [Fact]
    public void Wanted_ShouldIgnoreProductsTheFeedDoesNotOffer()
    {
        var demand = New(out _, pinned: ["ES", "ZN"]);
        demand.Acquire(InstrumentRoot.Parse("HE"));

        demand.Wanted(Available, out _).Should().BeEquivalentTo([InstrumentRoot.ES]);
    }

    [Fact]
    public void Wanted_ShouldBeEveryProduct_InAllMode()
    {
        DepthDemand.Everything().Wanted(Available, out var limited).Should().BeEquivalentTo(Available);
        limited.Should().BeEmpty();
    }

    [Fact]
    public void Release_ShouldIgnoreAProductNobodyHeld_AndVersionShouldMoveOnChanges()
    {
        var demand = New(out _);
        var version = demand.Version;

        demand.Release(Nq);
        demand.Version.Should().Be(version);
        demand.Acquire(Nq);
        demand.Version.Should().BeGreaterThan(version);
    }

    [Fact]
    public void Constructor_ShouldRefuseAPinnedValueThatIsNotARoot()
    {
        var act = () => new DepthDemand(new DepthOptions { Pinned = ["E-S"] }, TimeProvider.System);

        act.Should().Throw<InvalidOperationException>().WithMessage("*E-S*");
    }

    private static DepthDemand New(out ManualTime time, string[]? pinned = null, int max = 0, int releaseDelayMs = 0)
    {
        time = new ManualTime(TestData.Epoch);
        return new DepthDemand(new DepthOptions { Pinned = [.. pinned ?? []], MaxSubscriptions = max, ReleaseDelayMs = releaseDelayMs }, time);
    }
}
