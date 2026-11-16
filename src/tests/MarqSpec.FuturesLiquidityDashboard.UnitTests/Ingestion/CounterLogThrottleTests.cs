using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: REQUIREMENTS.md FR-5; OBSERVABILITY.md §2 (logs)
public sealed class CounterLogThrottleTests
{
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Take_ShouldReturnNothing_WhenTheCounterHasNotGrown()
    {
        var throttle = new CounterLogThrottle(TimeSpan.FromMinutes(1));

        throttle.Take(InstrumentRoot.MES, 0, T0).Should().BeNull();
    }

    [Fact]
    public void Take_ShouldReturnTheWholeCount_WhenTheCounterFirstGrows()
    {
        var throttle = new CounterLogThrottle(TimeSpan.FromMinutes(1));

        throttle.Take(InstrumentRoot.MES, 3, T0).Should().Be(3);
    }

    [Fact]
    public void Take_ShouldHoldBackALine_WhenTheCounterGrowsAgainWithinTheInterval()
    {
        var throttle = new CounterLogThrottle(TimeSpan.FromMinutes(1));
        throttle.Take(InstrumentRoot.MES, 3, T0);

        throttle.Take(InstrumentRoot.MES, 5, T0 + 59_999).Should().BeNull();
    }

    [Fact]
    public void Take_ShouldReturnTheCountSinceTheLastLine_WhenTheIntervalHasPassed()
    {
        var throttle = new CounterLogThrottle(TimeSpan.FromMinutes(1));
        throttle.Take(InstrumentRoot.MES, 3, T0);
        throttle.Take(InstrumentRoot.MES, 5, T0 + 30_000);

        throttle.Take(InstrumentRoot.MES, 9, T0 + 60_000).Should().Be(6, "the five held back since the last line are not lost");
        throttle.Take(InstrumentRoot.MES, 9, T0 + 200_000).Should().BeNull("nothing new since the last line");
    }

    [Fact]
    public void Take_ShouldThrottleEachInstrumentOnItsOwn_WhenTwoGrowTogether()
    {
        var throttle = new CounterLogThrottle(TimeSpan.FromMinutes(1));
        throttle.Take(InstrumentRoot.MES, 3, T0);

        throttle.Take(InstrumentRoot.MCL, 2, T0 + 1_000).Should().Be(2);
    }
}
