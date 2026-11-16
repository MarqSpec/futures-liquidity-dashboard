namespace MarqSpec.FuturesLiquidityDashboard.UnitTests;

/// <summary>A clock that only moves when a test says so (timers are not driven; use it for "now" only).</summary>
public sealed class ManualTime(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan by) => _now += by;
}
