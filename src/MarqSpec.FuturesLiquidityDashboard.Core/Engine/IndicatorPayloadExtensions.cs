namespace MarqSpec.FuturesLiquidityDashboard.Core.Engine;

/// <summary>
/// A viewer's indicator timeframe (INTERFACES.md D.2). The engine keeps the 1-, 5- and 15-minute series;
/// a snapshot or delta sent to one connection carries only the series that connection asked for.
/// </summary>
public static class IndicatorPayloadExtensions
{
    /// <summary>The layout default, and the value used when a caller omits the timeframe or sends one that is not a choice.</summary>
    public const int DefaultMinutes = 1;

    /// <summary>1, 5 or 15. Any other value, including one left off the hub call, is <see cref="DefaultMinutes"/>.</summary>
    public static int NormalizeIndicatorMinutes(int minutes) => minutes switch
    {
        5 => 5,
        15 => 15,
        _ => DefaultMinutes,
    };

    /// <summary>The wire <c>tf</c> for <paramref name="minutes"/>, in seconds.</summary>
    public static int IndicatorTimeframeSeconds(int minutes) => NormalizeIndicatorMinutes(minutes) switch
    {
        1 => 60,
        5 => 300,
        15 => 900,
        _ => throw new InvalidOperationException("NormalizeIndicatorMinutes returned a value with no timeframe."),
    };

    /// <summary>A copy of <paramref name="snapshot"/> whose indicators are only <paramref name="minutes"/>.</summary>
    public static DashboardSnapshot ForIndicatorMinutes(this DashboardSnapshot snapshot, int minutes)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        return snapshot with { Indicators = Matching(snapshot.Indicators, minutes) };
    }

    /// <summary>A copy of <paramref name="delta"/> whose indicators are only <paramref name="minutes"/>. Sequence is unchanged.</summary>
    public static DashboardDelta ForIndicatorMinutes(this DashboardDelta delta, int minutes)
    {
        ArgumentNullException.ThrowIfNull(delta);
        return delta with { Indicators = Matching(delta.Indicators, minutes) };
    }

    private static List<IndicatorDto> Matching(IReadOnlyList<IndicatorDto> indicators, int minutes)
    {
        var timeframe = IndicatorTimeframeSeconds(minutes);
        return indicators.Where(series => series.Tf == timeframe).ToList();
    }
}
