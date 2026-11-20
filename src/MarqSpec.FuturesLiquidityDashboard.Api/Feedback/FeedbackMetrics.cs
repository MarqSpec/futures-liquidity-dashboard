using System.Diagnostics;
using System.Diagnostics.Metrics;
using MarqSpec.FuturesLiquidityDashboard.Api.Telemetry;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>
/// Feedback counters for Prometheus (OBSERVABILITY.md §2). Every label is a bounded code: the provider, the outcome or
/// the token kind; never a viewer, a key, a prompt or a reply (CONVENTIONS.md §7).
/// </summary>
public sealed class FeedbackMetrics : IDisposable
{
    public const string MeterName = DashboardMetrics.MeterName;
    private readonly Meter _meter;
    private readonly Counter<long> _requests;
    private readonly Histogram<double> _duration;
    private readonly Counter<long> _tokens;

    public FeedbackMetrics(IMeterFactory meters, FeedbackBudget budget)
    {
        ArgumentNullException.ThrowIfNull(meters);
        ArgumentNullException.ThrowIfNull(budget);
        _meter = meters.Create(MeterName);
        _requests = _meter.CreateCounter<long>("fld.feedback.requests", description: "Feedback requests by provider and outcome: ok, refusal, timeout, error, invalid-response, over-budget, throttled, unavailable.");
        _duration = _meter.CreateHistogram<double>("fld.feedback.duration", "ms", "Time a feedback model call took, by provider and outcome.");
        _tokens = _meter.CreateCounter<long>("fld.feedback.tokens", description: "Tokens the Claude calls used, by kind: input, output, cache-write, cache-read.");
        // No unit: the Prometheus exporter would append it, and the names already say USD (OBSERVABILITY.md §2).
        _meter.CreateObservableGauge("fld.feedback.spend_usd", () => (double)budget.Current().SpentUsd, description: "This UTC month's Claude spend in US dollars, kept in the budget file across restarts.");
        _meter.CreateObservableGauge("fld.feedback.budget_usd", () => (double)budget.Current().BudgetUsd, description: "The monthly cap in US dollars, Feedback:MonthlyBudgetUsd.");
    }

    /// <summary>Counts one request's outcome, and the call's duration when a call was made.</summary>
    public void Outcome(string provider, string outcome, double? latencyMs)
    {
        var tags = new TagList { { "provider", provider }, { "outcome", outcome } };
        _requests.Add(1, tags);
        if (latencyMs is { } ms)
        {
            _duration.Record(ms, tags);
        }
    }

    public void Tokens(TokenUsage usage)
    {
        ArgumentNullException.ThrowIfNull(usage);
        _tokens.Add(usage.InputTokens, new KeyValuePair<string, object?>("kind", "input"));
        _tokens.Add(usage.OutputTokens, new KeyValuePair<string, object?>("kind", "output"));
        _tokens.Add(usage.CacheWriteTokens, new KeyValuePair<string, object?>("kind", "cache-write"));
        _tokens.Add(usage.CacheReadTokens, new KeyValuePair<string, object?>("kind", "cache-read"));
    }

    public void Dispose() => _meter.Dispose();
}
