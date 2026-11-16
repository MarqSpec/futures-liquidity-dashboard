using MarqSpec.FuturesLiquidityDashboard.Core.Profile;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Profile;

// reference: REQUIREMENTS.md FR-23, FR-24, FR-25
public sealed class VolumeProfileTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void ComputeValueArea_ShouldExpandFromThePocUntilTheTargetIsHeld_WhenGivenAProfile()
    {
        // POC 102 (40); tie 20/20 goes to the lower bin (101, 60 total), then 103 (20) beats 100 (10): 80 ≥ 70.
        var bins = new Dictionary<long, long> { [100] = 10, [101] = 20, [102] = 40, [103] = 20, [104] = 10 };

        var area = VolumeProfile.ComputeValueArea(bins);

        area.Should().Be(new ValueArea(PocTicks: 102, HighTicks: 103, LowTicks: 101, Volume: 80, TotalVolume: 100));
        area!.Fraction.Should().Be(0.8);
    }

    [Fact]
    public void ComputeValueArea_ShouldPickTheLowerPriceAsPoc_WhenBinsTie()
    {
        var bins = new Dictionary<long, long> { [100] = 5, [101] = 5 };

        VolumeProfile.ComputeValueArea(bins)!.PocTicks.Should().Be(100);
    }

    [Fact]
    public void ComputeValueArea_ShouldCountMissingTicksAsEmpty_WhenTradedPricesHaveGaps()
    {
        // 100 and 103 with nothing between: the area has to walk across the empty 101 and 102 to reach 100.
        var bins = new Dictionary<long, long> { [100] = 4, [103] = 6 };

        var area = VolumeProfile.ComputeValueArea(bins)!;

        (area.PocTicks, area.LowTicks, area.HighTicks, area.Volume).Should().Be((103L, 100L, 103L, 10L));
    }

    [Fact]
    public void ComputeValueArea_ShouldReturnNull_WhenTheProfileIsEmpty()
    {
        VolumeProfile.ComputeValueArea(new Dictionary<long, long>()).Should().BeNull();
    }

    [Fact]
    public void Snapshot_ShouldReportBinsTotalAndValueArea_WhenTradesWereAdded()
    {
        var profile = VolumeProfile.Session();
        profile.ResetSession("2026-11-10", null);
        profile.Add(T0, 100, 2);
        profile.Add(T0, 101, 5);
        profile.Add(T0 + 1, 100, 1);

        var snapshot = profile.Snapshot();

        snapshot.Bins.Should().Equal(new KeyValuePair<long, long>(100, 3), new KeyValuePair<long, long>(101, 5));
        snapshot.TotalVolume.Should().Be(8);
        snapshot.ValueArea!.PocTicks.Should().Be(101);
    }

    [Fact]
    public void ResetSession_ShouldClearTheWindow_WhenANewSessionStarts()
    {
        var profile = VolumeProfile.Session();
        profile.Add(T0, 100, 2);

        profile.ResetSession("2026-11-11", partialSinceMs: T0);

        profile.TotalVolume.Should().Be(0);
        profile.Snapshot().Bins.Should().BeEmpty();
        profile.PartialSinceMs.Should().Be(T0);
        profile.SessionId.Should().Be("2026-11-11");
    }

    [Theory]
    [InlineData(3_600_999, 8)]
    [InlineData(3_601_000, 3)]
    public void Expire_ShouldDropSecondsOlderThanTheRollingWindow_WhenTimeAdvances(int afterMs, long remaining)
    {
        var profile = VolumeProfile.Rolling(TimeSpan.FromHours(1), "1h");
        profile.Add(T0, 100, 5);
        profile.Add(T0 + 1_500, 101, 3);

        profile.Expire(T0 + afterMs);

        profile.TotalVolume.Should().Be(remaining);
    }

    [Fact]
    public void Expire_ShouldNeverDropTrades_WhenTheWindowIsTheSession()
    {
        var profile = VolumeProfile.Session();
        profile.Add(T0, 100, 5);

        profile.Expire(T0 + (48L * 3_600_000));

        profile.TotalVolume.Should().Be(5);
    }

    [Fact]
    public void MarkPartialSince_ShouldKeepTheFirstMark_WhenCalledTwice()
    {
        var profile = VolumeProfile.Session();

        profile.MarkPartialSince(T0);
        profile.MarkPartialSince(T0 + 5);

        profile.PartialSinceMs.Should().Be(T0);
    }

    [Fact]
    public void Expire_ShouldKeepATradeInsideFiveDays_WhenAnOlderTradeFallsOut()
    {
        var profile = VolumeProfile.Rolling(TimeSpan.FromDays(5), "5d");
        var day = 86_400_000L;
        profile.Add(T0, 100, 4);
        profile.Add(T0 + (4 * day), 101, 7);

        profile.Expire(T0 + (5 * day) + 1_000);

        profile.TotalVolume.Should().Be(7);
        profile.Snapshot().ValueArea!.PocTicks.Should().Be(101);
        profile.Snapshot().Window.Should().Be("5d");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Add_ShouldThrow_WhenQuantityIsNotPositive(long quantity)
    {
        var act = () => VolumeProfile.Session().Add(T0, 100, quantity);

        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}
