using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.OrderFlow;

// reference: REQUIREMENTS.md FR-69, ARCHITECTURE.md D-41 (signals kept for the history window, then capped)
public sealed class SignalLogTests
{
    private const long RetentionMs = 30 * 60_000;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Add_ShouldAssignIncreasingIds_WhenSignalsAreAdded()
    {
        var log = Log();

        var first = Add(log, SignalKind.StackedImbalance, T0);
        var second = Add(log, SignalKind.Iceberg, T0 + 1_000);

        (first.Id, second.Id, log.LastId).Should().Be((1L, 2L, 2L));
    }

    [Fact]
    public void Add_ShouldKeepMoreThanOneHundredOfOneKind_WhenTheyAreInsideTheWindow()
    {
        var log = Log(cap: 20_000);
        var iceberg = Add(log, SignalKind.Iceberg, T0);
        for (var i = 0; i < 150; i++)
        {
            Add(log, SignalKind.StackedImbalance, T0 + ((i + 1) * 1_000));
        }

        log.All.Count(s => s.Kind == SignalKind.StackedImbalance).Should().Be(150);
        log.All.Should().Contain(iceberg);
    }

    [Fact]
    public void Add_ShouldDropASignalOlderThanTheRetention_WhenALaterSignalArrives()
    {
        var log = Log();
        var stale = Add(log, SignalKind.StackedImbalance, T0);
        var kept = Add(log, SignalKind.Iceberg, T0 + RetentionMs + 1);

        log.All.Should().ContainSingle().Which.Should().Be(kept);
        log.All.Should().NotContain(stale);
        log.Since(0).Should().ContainSingle().Which.Should().Be(kept);
    }

    [Fact]
    public void Prune_ShouldKeepFromTheFirstSignalInsideTheWindow_WhenOlderOnesPrecedeIt()
    {
        var log = Log(cap: 20);
        for (var i = 0; i < 4; i++)
        {
            Add(log, SignalKind.StackedImbalance, T0 + (i * 1_000));
        }

        var edge = Add(log, SignalKind.Iceberg, T0 + 4_000);
        var after = Add(log, SignalKind.Spoof, T0 + 5_000);

        log.Prune(T0 + RetentionMs + 4_000);

        log.All.Select(s => s.Id).Should().Equal(edge.Id, after.Id);
    }

    [Fact]
    public void Prune_ShouldDropASignalOlderThanTheRetention_WhenTheClockMovesWithoutANewSignal()
    {
        var log = Log();
        var stale = Add(log, SignalKind.Spoof, T0);
        var kept = Add(log, SignalKind.LiquiditySweep, T0 + 60_000);

        log.Prune(T0 + 60_000 + RetentionMs);

        log.All.Should().ContainSingle().Which.Should().Be(kept);
        log.All.Should().NotContain(stale);
    }

    [Fact]
    public void Add_ShouldDropTheOldestIds_WhenTheCapIsExceededInsideTheWindow()
    {
        var log = Log(cap: 3);
        Add(log, SignalKind.Iceberg, T0);
        Add(log, SignalKind.Spoof, T0 + 1_000);
        var third = Add(log, SignalKind.StackedImbalance, T0 + 2_000);
        var fourth = Add(log, SignalKind.LiquiditySweep, T0 + 3_000);
        var fifth = Add(log, SignalKind.SinglePrints, T0 + 4_000);

        log.All.Select(s => s.Id).Should().Equal(third.Id, fourth.Id, fifth.Id);
        log.All.Should().NotContain(s => s.Kind == SignalKind.Iceberg);
    }

    [Fact]
    public void Add_ShouldDropASignalBehindTheNewest_WhenItsTimeMovesBackwards()
    {
        var log = Log();
        var older = Add(log, SignalKind.StackedImbalance, T0);
        var newest = Add(log, SignalKind.Iceberg, T0 + 2_000);

        var late = log.Add(SignalKind.LiquiditySweep, SignalBias.Bearish, T0 + 1_000, 100, 100, 0.5, "sweep", "synthetic");

        late.Should().BeNull();
        log.LateDropped.Should().Be(1);
        log.LastId.Should().Be(newest.Id);
        log.All.Should().Equal(older, newest);
        log.CountAfter(T0).Should().Be(1);
        log.CountAfter(T0 + 1_000).Should().Be(1);
        log.CountAfter(T0 + 2_000).Should().Be(0);
        log.Newest.Should().Be(newest);

        log.Prune(T0 + 2_000);
        log.All.Should().Equal(older, newest);

        log.Prune(T0 + 2_000 + RetentionMs);
        log.All.Should().ContainSingle().Which.Should().Be(newest);
    }

    [Fact]
    public void Add_ShouldKeepASignal_WhenItsTimeEqualsTheNewest()
    {
        var log = Log();
        var first = Add(log, SignalKind.Spoof, T0 + 1_000);
        var same = Add(log, SignalKind.LiquiditySweep, T0 + 1_000);
        var later = Add(log, SignalKind.Iceberg, T0 + 1_001);

        log.All.Should().Equal(first, same, later);
        log.LateDropped.Should().Be(0);
        log.CountAfter(T0).Should().Be(3);
        log.CountAfter(T0 + 1_000).Should().Be(1);
    }

    [Fact]
    public void CountAfter_ShouldCountOnlyTheTail_WhenOlderSignalsRemain()
    {
        var log = Log();
        Add(log, SignalKind.StackedImbalance, T0);
        Add(log, SignalKind.Iceberg, T0 + 1_000);
        var newest = Add(log, SignalKind.Spoof, T0 + 2_000);

        log.Newest.Should().Be(newest);
        log.CountAfter(T0 + 1_000).Should().Be(1);
        log.CountAfter(T0 + 2_000).Should().Be(0);
        log.TakeLast(2).Select(s => s.Id).Should().Equal(2, 3);
        log.TakeLast(10).Should().HaveCount(3);
    }

    [Fact]
    public void InWindow_ShouldOmitSignalsBeforeTheRequestedStart_WhenTheLogStillHoldsThem()
    {
        var log = Log(retentionMs: 3 * 60 * 60_000);
        var older = Add(log, SignalKind.StackedImbalance, T0);
        var inside = Add(log, SignalKind.StackedImbalance, T0 + (2 * 60 * 60_000));

        log.InWindow(T0 + (60 * 60_000)).Should().ContainSingle().Which.Should().Be(inside);
        log.All.Should().Contain(older);
    }

    [Fact]
    public void All_ShouldListSignalsInIdOrder_WhenKindsAreInterleaved()
    {
        var log = Log();
        Add(log, SignalKind.Spoof, T0);
        Add(log, SignalKind.Iceberg, T0 + 1_000);
        Add(log, SignalKind.Spoof, T0 + 2_000);

        log.All.Select(s => s.Id).Should().Equal(1, 2, 3);
    }

    [Fact]
    public void Since_ShouldReturnOnlyLaterSignals_WhenGivenAnId()
    {
        var log = Log();
        Add(log, SignalKind.Spoof, T0);
        Add(log, SignalKind.Iceberg, T0 + 1_000);
        Add(log, SignalKind.LiquiditySweep, T0 + 2_000);

        log.Since(1).Select(s => s.Id).Should().Equal(2, 3);
        log.Since(3).Should().BeEmpty();
    }

    [Fact]
    public void Add_ShouldOrderTheZoneAndClampTheStrength_WhenGivenOutOfRangeValues()
    {
        var log = Log();

        var signal = log.Add(SignalKind.StackedImbalance, SignalBias.Bullish, T0, 105, 101, 1.7, "label", "detail");

        signal.Should().NotBeNull();
        (signal!.PriceTicks, signal.PriceHighTicks, signal.Strength).Should().Be((101L, 105L, 1.0));
    }

    [Fact]
    public void Add_ShouldRoundTheStrengthToThreeDecimals_WhenGivenAFraction()
    {
        var log = Log();

        var signal = log.Add(SignalKind.Spoof, SignalBias.Bearish, T0, 1, 1, 0.123456, "l", "d");

        signal.Should().NotBeNull();
        signal!.Strength.Should().Be(0.123);
    }

    [Fact]
    public void Add_ShouldStopAtTheCapCeiling_WhenTheRequestedCapIsLarger()
    {
        var log = new SignalLog(RetentionMs, int.MaxValue);
        var ceiling = OrderFlowOptions.MaxSignalHistoryCap;
        for (var i = 0; i < ceiling + 1; i++)
        {
            Add(log, SignalKind.StackedImbalance, T0 + i);
        }

        log.All.Should().HaveCount(ceiling);
        log.All[0].Id.Should().Be(2);
        log.Newest!.Id.Should().Be(ceiling + 1);
    }

    [Fact]
    public void Add_ShouldStillKeepOneSignal_WhenTheCapIsZero()
    {
        var log = new SignalLog(RetentionMs, cap: 0);

        Add(log, SignalKind.Spoof, T0);
        var last = Add(log, SignalKind.Spoof, T0 + 1_000);

        log.All.Should().ContainSingle().Which.Should().Be(last);
    }

    private static SignalLog Log(long retentionMs = RetentionMs, int cap = 100) => new(retentionMs, cap);

    private static OrderFlowSignal Add(SignalLog log, SignalKind kind, long timeMs)
    {
        var signal = log.Add(kind, SignalBias.Neutral, timeMs, 100, 100, 0.5, kind.ToString(), "synthetic");
        signal.Should().NotBeNull();
        return signal!;
    }
}
