namespace MarqSpec.FuturesLiquidityDashboard.Core.Levels;

/// <summary>One support or resistance price and how many distinct approaches have reached it.</summary>
public sealed record LevelTouch(
    string Name,
    long PriceTicks,
    bool IsHigh,
    int Touches,
    long? LastTouchMs,
    string? SessionId = null,
    long? AsOfMs = null)
{
    /// <summary>The approach a discretionary trader is waiting on: the third time price has come back to the level.</summary>
    public bool IsThirdTouch => Touches == 3;
}

/// <summary>
/// Counts distinct approaches to a price. A touch is the first bar whose range comes within
/// <paramref name="proximityTicks"/> of the level after price has been outside that band. Bars that stay inside
/// the band do not add touches (REQUIREMENTS.md: a third-touch bounce is a return, not a dwell).
/// </summary>
public static class LevelTouchCounter
{
    public const int DefaultProximityTicks = 2;

    public static IReadOnlyList<long> TouchTimes(
        IEnumerable<(long TimeMs, long Low, long High)> bars,
        long levelTicks,
        int proximityTicks = DefaultProximityTicks)
    {
        ArgumentNullException.ThrowIfNull(bars);
        ArgumentOutOfRangeException.ThrowIfNegative(proximityTicks);
        var times = new List<long>();
        var armed = true;
        foreach (var (timeMs, low, high) in bars)
        {
            if (high < low)
            {
                continue;
            }

            var near = high >= levelTicks - proximityTicks && low <= levelTicks + proximityTicks;
            if (near && armed)
            {
                times.Add(timeMs);
                armed = false;
            }
            else if (!near)
            {
                armed = true;
            }
        }

        return times;
    }

    public static LevelTouch Count(
        string name,
        long priceTicks,
        bool isHigh,
        IEnumerable<(long TimeMs, long Low, long High)> bars,
        int proximityTicks = DefaultProximityTicks,
        string? sessionId = null,
        long? asOfMs = null)
    {
        var times = TouchTimes(bars, priceTicks, proximityTicks);
        return new LevelTouch(name, priceTicks, isHigh, times.Count, times.Count == 0 ? null : times[^1], sessionId, asOfMs);
    }
}
