namespace MarqSpec.FuturesLiquidityDashboard.Core.Levels;

/// <summary>
/// One support or resistance price, how many distinct approaches have reached it, and how many of those held or
/// broke (REQUIREMENTS.md FR-79, ARCHITECTURE.md D-65). <see cref="Held"/> plus <see cref="Broke"/> is <see cref="Touches"/>.
/// </summary>
public sealed record LevelTouch(
    string Name,
    long PriceTicks,
    bool IsHigh,
    int Touches,
    long? LastTouchMs,
    string? SessionId = null,
    long? AsOfMs = null,
    int Held = 0,
    int Broke = 0)
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

    /// <summary>How far beyond the level a closed bar must close for the touch to count as broke (REQUIREMENTS.md FR-79).</summary>
    public const int BreakTicks = 2;

    public static IReadOnlyList<long> TouchTimes(
        IEnumerable<(long TimeMs, long Low, long High, long? Close)> bars,
        long levelTicks,
        int proximityTicks = DefaultProximityTicks)
    {
        ArgumentNullException.ThrowIfNull(bars);
        ArgumentOutOfRangeException.ThrowIfNegative(proximityTicks);
        var valid = Valid(bars);
        return Walk(valid, levelTicks, proximityTicks, isHigh: true).Select(touch => valid[touch.Index].TimeMs).ToList();
    }

    /// <summary>
    /// Counts the touches and judges each one. A touch broke when a closed bar from the touch bar up to the next
    /// touch closes at least <see cref="BreakTicks"/> beyond the level, on the far side from where price came;
    /// otherwise it held. A bar with no close (the developing minute) cannot break a level.
    /// </summary>
    public static LevelTouch Count(
        string name,
        long priceTicks,
        bool isHigh,
        IEnumerable<(long TimeMs, long Low, long High, long? Close)> bars,
        int proximityTicks = DefaultProximityTicks,
        string? sessionId = null,
        long? asOfMs = null)
    {
        ArgumentNullException.ThrowIfNull(bars);
        ArgumentOutOfRangeException.ThrowIfNegative(proximityTicks);
        var valid = Valid(bars);
        var touches = Walk(valid, priceTicks, proximityTicks, isHigh);
        var broke = 0;
        for (var i = 0; i < touches.Count; i++)
        {
            var end = i + 1 < touches.Count ? touches[i + 1].Index : valid.Count;
            if (ClosedBeyond(valid, touches[i].Index, end, priceTicks, touches[i].FromBelow))
            {
                broke++;
            }
        }

        var last = touches.Count == 0 ? (long?)null : valid[touches[^1].Index].TimeMs;
        return new LevelTouch(name, priceTicks, isHigh, touches.Count, last, sessionId, asOfMs, touches.Count - broke, broke);
    }

    private static List<(long TimeMs, long Low, long High, long? Close)> Valid(IEnumerable<(long TimeMs, long Low, long High, long? Close)> bars) =>
        bars.Where(bar => bar.High >= bar.Low).ToList();

    private static List<(int Index, bool FromBelow)> Walk(
        List<(long TimeMs, long Low, long High, long? Close)> bars,
        long levelTicks,
        int proximityTicks,
        bool isHigh)
    {
        var touches = new List<(int Index, bool FromBelow)>();
        var armed = true;
        // Until price has been seen off the level, a high is taken as reached from below and a low from above.
        var fromBelow = isHigh;
        for (var i = 0; i < bars.Count; i++)
        {
            var (_, low, high, _) = bars[i];
            var near = high >= levelTicks - proximityTicks && low <= levelTicks + proximityTicks;
            if (near && armed)
            {
                touches.Add((i, fromBelow));
                armed = false;
            }
            else if (!near)
            {
                armed = true;
                fromBelow = high < levelTicks - proximityTicks;
            }
        }

        return touches;
    }

    private static bool ClosedBeyond(
        List<(long TimeMs, long Low, long High, long? Close)> bars,
        int start,
        int end,
        long levelTicks,
        bool fromBelow)
    {
        for (var i = start; i < end; i++)
        {
            if (bars[i].Close is not { } close)
            {
                continue;
            }

            if (fromBelow ? close >= levelTicks + BreakTicks : close <= levelTicks - BreakTicks)
            {
                return true;
            }
        }

        return false;
    }
}
