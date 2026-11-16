namespace MarqSpec.FuturesLiquidityDashboard.Core.Heatmap;

/// <summary>
/// One price cell of one time slice: the integral of resting quantity over the milliseconds the price was known
/// (REQUIREMENTS.md FR-12). The heat value is the time-weighted mean over the known milliseconds only.
/// </summary>
public readonly record struct HeatCell(long PriceTicks, double BidQuantityMs, double AskQuantityMs, int KnownMs)
{
    public double? BidTimeWeighted => KnownMs > 0 ? BidQuantityMs / KnownMs : null;

    public double? AskTimeWeighted => KnownMs > 0 ? AskQuantityMs / KnownMs : null;
}

/// <summary>A closed time slice on the shared grid, half-open [StartMs, StartMs + DurationMs) (REQUIREMENTS.md FR-1).</summary>
public sealed record HeatmapColumn(long StartMs, int DurationMs, IReadOnlyList<HeatCell> Cells)
{
    /// <summary>Combines adjacent columns into one wider slice by adding integrals and known durations, never averaging means (REQUIREMENTS.md FR-12).</summary>
    public static HeatmapColumn Combine(long startMs, int durationMs, IEnumerable<HeatmapColumn> columns)
    {
        ArgumentNullException.ThrowIfNull(columns);
        var cells = columns
            .SelectMany(c => c.Cells)
            .GroupBy(c => c.PriceTicks)
            .Select(g => new HeatCell(g.Key, g.Sum(c => c.BidQuantityMs), g.Sum(c => c.AskQuantityMs), g.Sum(c => c.KnownMs)))
            .OrderBy(c => c.PriceTicks)
            .ToList();
        return new HeatmapColumn(startMs, durationMs, cells);
    }
}
