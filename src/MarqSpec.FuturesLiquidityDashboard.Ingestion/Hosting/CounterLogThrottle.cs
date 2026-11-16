using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

/// <summary>
/// Decides when a growing per-instrument counter earns a log line: the first growth at once, then at most one line
/// per <paramref name="interval"/>, carrying the count since the last line so nothing held back is lost.
/// Not thread-safe: one loop owns it.
/// </summary>
internal sealed class CounterLogThrottle(TimeSpan interval)
{
    private readonly long _intervalMs = (long)interval.TotalMilliseconds;
    private readonly Dictionary<InstrumentRoot, (long Logged, long AtMs)> _last = [];

    /// <summary>The count to log now, or null when the counter has not grown or the last line was too recent.</summary>
    public long? Take(InstrumentRoot root, long total, long nowMs)
    {
        var seen = _last.TryGetValue(root, out var last);
        var logged = seen ? last.Logged : 0;
        if (total <= logged || (seen && nowMs - last.AtMs < _intervalMs))
        {
            return null;
        }

        _last[root] = (total, nowMs);
        return total - logged;
    }
}
