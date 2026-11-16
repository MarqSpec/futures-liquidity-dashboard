namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>A high- or low-volume node of a volume profile (REQUIREMENTS.md FR-50).</summary>
public sealed record VolumeNode(long PriceTicks, double SmoothedVolume, bool IsHigh);

/// <summary>
/// HVN/LVN detection (ARCHITECTURE.md D-24). The profile is filled to a contiguous tick range and smoothed with a
/// centred moving average of half-width <c>NodeSmoothingTicks</c>. An HVN is a local maximum of the smoothed curve
/// (over one more tick than the smoothing half-width each side) at least <c>HvnMultiple</c> times the mean; an LVN
/// is a local minimum at most <c>LvnMultiple</c> times the mean that lies between two higher-volume prices, so the
/// thin tails at the profile's edges are not called nodes. Plateaus report their lowest price.
/// </summary>
public static class ProfileNodes
{
    public static IReadOnlyList<VolumeNode> Find(IReadOnlyList<KeyValuePair<long, long>> bins, OrderFlowOptions options)
    {
        ArgumentNullException.ThrowIfNull(bins);
        ArgumentNullException.ThrowIfNull(options);
        if (bins.Count < 5)
        {
            return [];
        }

        var low = bins.Min(b => b.Key);
        var high = bins.Max(b => b.Key);
        if (high - low > 20_000)
        {
            return [];
        }

        var raw = new double[high - low + 1];
        foreach (var bin in bins)
        {
            raw[bin.Key - low] = bin.Value;
        }

        var w = Math.Max(0, options.NodeSmoothingTicks);
        var smooth = new double[raw.Length];
        for (var i = 0; i < raw.Length; i++)
        {
            var from = Math.Max(0, i - w);
            var to = Math.Min(raw.Length - 1, i + w);
            var sum = 0.0;
            for (var j = from; j <= to; j++)
            {
                sum += raw[j];
            }

            smooth[i] = sum / (to - from + 1);
        }

        var mean = smooth.Average();
        if (mean <= 0)
        {
            return [];
        }

        var r = w + 1;
        var hvn = new List<VolumeNode>();
        var lvn = new List<VolumeNode>();
        for (var i = 0; i < smooth.Length; i++)
        {
            var v = smooth[i];
            if (IsExtreme(smooth, i, r, max: true) && v >= options.HvnMultiple * mean)
            {
                hvn.Add(new VolumeNode(low + i, Math.Round(v, 2), IsHigh: true));
            }

            if (i >= r && i < smooth.Length - r && IsExtreme(smooth, i, r, max: false) && v <= options.LvnMultiple * mean
                && smooth.Take(i).Max() > v * 2 && smooth.Skip(i + 1).Max() > v * 2)
            {
                lvn.Add(new VolumeNode(low + i, Math.Round(v, 2), IsHigh: false));
            }
        }

        return hvn.OrderByDescending(n => n.SmoothedVolume).Take(options.MaxNodes)
            .Concat(lvn.OrderBy(n => n.SmoothedVolume).Take(options.MaxNodes))
            .OrderBy(n => n.PriceTicks)
            .ToList();
    }

    private static bool IsExtreme(double[] values, int i, int radius, bool max)
    {
        var v = values[i];
        for (var j = Math.Max(0, i - radius); j <= Math.Min(values.Length - 1, i + radius); j++)
        {
            if (j == i)
            {
                continue;
            }

            var other = values[j];
            var beaten = max ? other > v : other < v;
            var tiedBefore = j < i && other == v;
            if (beaten || tiedBefore)
            {
                return false;
            }
        }

        return true;
    }
}
