using MarqSpec.FuturesLiquidityDashboard.Core.Plans;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;

// The wire shapes of REQUIREMENTS.md FR-74 (INTERFACES.md D.1). Advisory text about a simulated plan; nothing here
// places, changes or cancels an order (FR-6).

/// <summary>Why feedback is unavailable, or why a reply carries none.</summary>
public static class FeedbackReasons
{
    public const string Disabled = "disabled";
    public const string NoKey = "no-key";
    public const string BudgetExhausted = "budget-exhausted";
    public const string RateLimited = "rate-limited";
    public const string RequestInFlight = "request-in-flight";
    public const string Refusal = "refusal";
    public const string Timeout = "timeout";
    public const string UpstreamRateLimited = "upstream-rate-limited";
    public const string UpstreamError = "upstream-error";
    public const string ConnectionError = "connection-error";
    public const string ApiError = "api-error";
    public const string Truncated = "truncated";
    public const string InvalidResponse = "invalid-response";
}

/// <summary>A price the feedback would consider instead, with why. Advice about the simulation only.</summary>
public sealed record FeedbackSuggestion(long PriceTicks, string Why);

/// <summary>The feedback on one leg of the plan, matched to a leg of the metrics.</summary>
/// <param name="Leg"><c>entry</c>, <c>stop</c> or <c>target</c>.</param>
/// <param name="Index">The target's position from 0; null for the entry and the stop.</param>
/// <param name="FillLikelihood"><c>low</c>, <c>medium</c>, <c>high</c> or <c>unknown</c>.</param>
/// <param name="Cites">The FR-73 metric names the claim relies on; never empty.</param>
public sealed record LegFeedback(string Leg, int? Index, string FillLikelihood, string Assessment, FeedbackSuggestion? Suggestion, IReadOnlyList<string> Cites);

/// <summary>A risk to the plan, with the metrics it rests on; never without one.</summary>
public sealed record FeedbackRisk(string Text, IReadOnlyList<string> Cites);

/// <summary>Grounded feedback: every leg claim and risk cites at least one known metric name.</summary>
/// <param name="AsOfMs">The metrics' <c>asOfMs</c>, set by the server, never by the model.</param>
/// <param name="DroppedCites">Claims dropped by grounding, each counted once: a cite that named no metric, a leg claim or risk
/// left with no cite, a leg the plan does not have or that repeats one, and a suggestion beyond the FR-72 tick range. The
/// wire name stays <c>droppedCites</c>.</param>
public sealed record PositionFeedback(
    string Summary,
    IReadOnlyList<LegFeedback> Legs,
    IReadOnlyList<FeedbackRisk> Risks,
    long AsOfMs,
    int DefinitionsVersion,
    int DroppedCites);

/// <summary>The reply of <c>POST /api/plans/feedback/{instrument}</c>: the metrics always, the feedback when it could be written.</summary>
/// <param name="Reason">Null with feedback; otherwise why there is none (<see cref="FeedbackReasons"/>).</param>
/// <param name="Provider"><c>claude</c> or <c>mock</c>.</param>
public sealed record PlanFeedbackReply(PlanMetrics Metrics, PositionFeedback? Feedback, string? Reason, string Provider, string Model);

/// <summary>The reply of <c>GET /api/plans/feedback/status</c>, and the body of a 503 or a budget 429. Holds no key.</summary>
/// <param name="Month">The UTC month the spend is counted for, <c>yyyy-MM</c>.</param>
/// <param name="ResetsAtMs">When the count starts again: the first instant of the next UTC month.</param>
public sealed record FeedbackStatus(
    bool Available,
    string? Reason,
    string Provider,
    string Model,
    decimal SpentUsd,
    decimal BudgetUsd,
    string Month,
    long ResetsAtMs);

/// <summary>The body of a refused request: a rate limit or a request already in flight.</summary>
public sealed record FeedbackRefusal(string Reason, int? RetryAfterSeconds);
