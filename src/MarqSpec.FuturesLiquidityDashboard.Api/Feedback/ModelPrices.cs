namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>
/// Per-model list prices, in US dollars per million tokens, that the monthly budget counts with (REQUIREMENTS.md NFR-9). Cache
/// writes are the five-minute rate, the one <c>cache_control</c> uses by default. The configured model must be listed,
/// so its spend can always be counted; a fallback model that is not is priced at the highest rates here.
/// </summary>
public static class ModelPrices
{
    private sealed record Rates(decimal Input, decimal Output, decimal CacheWrite, decimal CacheRead);

    // Anthropic list prices, 2026-11 (claude-api skill, shared/models.md). Revisit when a model's price changes.
    private static readonly Dictionary<string, Rates> Table = new(StringComparer.Ordinal)
    {
        // Opus 5.5 cache reads are $0.20, 0.05x input, not the 0.1x of the rows below (claude-api skill, shared/models.md model table).
        ["claude-opus-5-5"] = new(4m, 20m, 5m, 0.2m),
        ["claude-opus-5"] = new(5m, 25m, 6.25m, 0.5m),
        ["claude-opus-4-8"] = new(5m, 25m, 6.25m, 0.5m),
    };

    private static readonly Rates Highest = new(
        Table.Values.Max(r => r.Input),
        Table.Values.Max(r => r.Output),
        Table.Values.Max(r => r.CacheWrite),
        Table.Values.Max(r => r.CacheRead));

    public static IReadOnlyList<string> Models { get; } = [.. Table.Keys];

    public static bool IsKnown(string? model) => model is not null && Table.ContainsKey(model);

    /// <summary>The cost of one attempt. A model not in the table is priced at the highest rates in it.</summary>
    public static decimal CostUsd(TokenUsage usage)
    {
        ArgumentNullException.ThrowIfNull(usage);
        var rates = Table.GetValueOrDefault(usage.Model) ?? Highest;
        return ((usage.InputTokens * rates.Input)
            + (usage.OutputTokens * rates.Output)
            + (usage.CacheWriteTokens * rates.CacheWrite)
            + (usage.CacheReadTokens * rates.CacheRead)) / 1_000_000m;
    }
}
