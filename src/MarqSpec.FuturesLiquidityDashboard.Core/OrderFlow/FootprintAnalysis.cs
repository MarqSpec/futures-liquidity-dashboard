namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>A run of consecutive diagonally imbalanced ticks (REQUIREMENTS.md FR-42).</summary>
public sealed record ImbalanceZone(SignalBias Bias, long LowTicks, long HighTicks, int Levels, double AverageRatio);

/// <summary>An extreme of a bar where both sides still traded: the auction did not finish there (REQUIREMENTS.md FR-43).</summary>
public sealed record UnfinishedAuction(long PriceTicks, bool AtHigh, long BarStartMs, long BidVolume, long AskVolume);

/// <summary>
/// Pure reads of one footprint bar. Diagonal imbalance (ARCHITECTURE.md D-20): buying at P is imbalanced when the
/// ask volume at P is at least <c>ratio</c> times the bid volume at P−1, because a buyer lifting P competes with
/// the seller who hit P−1 one tick below; selling at P mirrors it against the ask volume at P+1. A zero opposite
/// cell counts as imbalanced once the dominant side reaches the minimum volume.
/// </summary>
public static class FootprintAnalysis
{
    /// <summary>+1 buy imbalance, −1 sell imbalance, 0 none, for every price in the bar.</summary>
    public static IReadOnlyDictionary<long, int> ImbalanceFlags(FootprintBar bar, double ratio, long minVolume)
    {
        ArgumentNullException.ThrowIfNull(bar);
        var flags = new Dictionary<long, int>();
        if (bar.Low is not { } low || bar.High is not { } high)
        {
            return flags;
        }

        for (var p = low; p <= high; p++)
        {
            var cell = bar.CellAt(p);
            var buy = IsImbalanced(cell.AskVolume, bar.CellAt(p - 1).BidVolume, ratio, minVolume);
            var sell = IsImbalanced(cell.BidVolume, bar.CellAt(p + 1).AskVolume, ratio, minVolume);
            flags[p] = buy && !sell ? 1 : sell && !buy ? -1 : 0;
        }

        return flags;
    }

    public static IReadOnlyList<ImbalanceZone> StackedImbalances(FootprintBar bar, double ratio, long minVolume, int minLevels)
    {
        ArgumentNullException.ThrowIfNull(bar);
        var flags = ImbalanceFlags(bar, ratio, minVolume);
        var zones = new List<ImbalanceZone>();
        if (bar.Low is not { } low || bar.High is not { } high)
        {
            return zones;
        }

        var runStart = low;
        var runFlag = 0;
        for (var p = low; p <= high + 1; p++)
        {
            var flag = p <= high ? flags[p] : 0;
            if (flag == runFlag)
            {
                continue;
            }

            if (runFlag != 0 && p - runStart >= minLevels)
            {
                zones.Add(Zone(bar, runFlag, runStart, p - 1));
            }

            runFlag = flag;
            runStart = p;
        }

        return zones;
    }

    public static IReadOnlyList<UnfinishedAuction> UnfinishedAuctions(FootprintBar bar)
    {
        ArgumentNullException.ThrowIfNull(bar);
        var found = new List<UnfinishedAuction>();
        if (bar.Low is not { } low || bar.High is not { } high)
        {
            return found;
        }

        var top = bar.CellAt(high);
        if (top.BidVolume > 0 && top.AskVolume > 0)
        {
            found.Add(new UnfinishedAuction(high, AtHigh: true, bar.StartMs, top.BidVolume, top.AskVolume));
        }

        var bottom = bar.CellAt(low);
        if (low != high && bottom.BidVolume > 0 && bottom.AskVolume > 0)
        {
            found.Add(new UnfinishedAuction(low, AtHigh: false, bar.StartMs, bottom.BidVolume, bottom.AskVolume));
        }

        return found;
    }

    private static bool IsImbalanced(long dominant, long opposite, double ratio, long minVolume) =>
        dominant >= Math.Max(1, minVolume) && dominant >= ratio * opposite;

    private static ImbalanceZone Zone(FootprintBar bar, int flag, long low, long high)
    {
        var ratios = new List<double>();
        for (var p = low; p <= high; p++)
        {
            var cell = bar.CellAt(p);
            var (dominant, opposite) = flag > 0
                ? (cell.AskVolume, bar.CellAt(p - 1).BidVolume)
                : (cell.BidVolume, bar.CellAt(p + 1).AskVolume);
            ratios.Add(opposite == 0 ? dominant : (double)dominant / opposite);
        }

        return new ImbalanceZone(flag > 0 ? SignalBias.Bullish : SignalBias.Bearish, low, high, (int)(high - low + 1), ratios.Average());
    }
}
