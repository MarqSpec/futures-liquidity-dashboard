using System.Diagnostics;
using System.Globalization;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>What a feedback request came to.</summary>
public abstract record FeedbackOutcome
{
    private FeedbackOutcome()
    {
    }

    /// <summary>Disabled or no key: a 503.</summary>
    public sealed record Unavailable(FeedbackStatus Status) : FeedbackOutcome;

    /// <summary>The month's budget is spent: a 429, and no call was made.</summary>
    public sealed record OverBudget(FeedbackStatus Status) : FeedbackOutcome;

    /// <summary>Rate-limited or already in flight for this viewer: a 429.</summary>
    public sealed record Refused(FeedbackRefusal Refusal) : FeedbackOutcome;

    /// <summary>A 200: the metrics, and the feedback or the reason there is none.</summary>
    public sealed record Answered(PlanFeedbackReply Reply) : FeedbackOutcome;
}

/// <summary>
/// Position feedback on request (REQUIREMENTS.md FR-74; ARCHITECTURE.md D-61): availability, the monthly budget, the per-viewer
/// gate, one model call under a deadline, and grounding. Any failure of the call degrades to the metrics alone with a
/// reason; nothing here touches ingestion (FR-8). Each call logs one line with the model, token counts, stop reason
/// and latency, or the outcome, the original exception type and the HTTP status, and never the key, the viewer, the prompt or the reply
/// (CONVENTIONS.md §7).
/// </summary>
public sealed partial class FeedbackService(
    IOptions<FeedbackOptions> options,
    IFeedbackModel model,
    FeedbackBudget budget,
    FeedbackGate gate,
    FeedbackMetrics metrics,
    TimeProvider time,
    ILogger<FeedbackService> logger)
{
    private bool IsMock => options.Value.Provider == FeedbackProvider.Mock;

    private string ModelName => IsMock ? "mock" : options.Value.Model;

    /// <summary>Whether feedback can be asked for now, and the month's spend against the cap. Holds no key.</summary>
    public FeedbackStatus Status()
    {
        var settings = options.Value;
        var state = budget.Current();
        var reason = !settings.Enabled ? FeedbackReasons.Disabled
            : IsMock ? null
            : !settings.HasKey ? FeedbackReasons.NoKey
            : state.Exhausted ? FeedbackReasons.BudgetExhausted
            : null;
        return new FeedbackStatus(reason is null, reason, model.Provider, ModelName, state.SpentUsd, state.BudgetUsd, state.Month, state.ResetsAtMs);
    }

    public async Task<FeedbackOutcome> RequestAsync(string viewer, PlanSpec plan, PlanMetrics planMetrics, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(planMetrics);
        var status = Status();
        switch (status.Reason)
        {
            case FeedbackReasons.Disabled or FeedbackReasons.NoKey:
                metrics.Outcome(model.Provider, "unavailable", null);
                return new FeedbackOutcome.Unavailable(status);
            case FeedbackReasons.BudgetExhausted:
                metrics.Outcome(model.Provider, "over-budget", null);
                return new FeedbackOutcome.OverBudget(status);
        }

        var entered = gate.TryEnter(viewer);
        if (entered.Lease is null)
        {
            metrics.Outcome(model.Provider, "throttled", null);
            return new FeedbackOutcome.Refused(entered.Refusal!);
        }

        using (entered.Lease)
        {
            var (feedback, reason) = await AskAsync(plan, planMetrics, cancellationToken).ConfigureAwait(false);
            return new FeedbackOutcome.Answered(new PlanFeedbackReply(planMetrics, feedback, reason, model.Provider, ModelName));
        }
    }

    private async Task<(PositionFeedback? Feedback, string? Reason)> AskAsync(PlanSpec plan, PlanMetrics planMetrics, CancellationToken cancellationToken)
    {
        var request = new FeedbackModelRequest(plan, planMetrics, FeedbackPrompt.UserMessage(plan, planMetrics));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(options.Value.TimeoutSeconds), time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        var started = time.GetTimestamp();
        ModelReply reply;
        try
        {
            reply = await model.CompleteAsync(request, linked.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            return Failed(FeedbackReasons.Timeout, "timeout", ex.GetType().Name, null, started);
        }
        catch (FeedbackModelException ex)
        {
            var reason = ex.Failure switch
            {
                FeedbackFailure.RateLimited => FeedbackReasons.UpstreamRateLimited,
                FeedbackFailure.ServerError => FeedbackReasons.UpstreamError,
                FeedbackFailure.Connection => FeedbackReasons.ConnectionError,
                FeedbackFailure.Timeout => FeedbackReasons.Timeout,
                FeedbackFailure.ApiError => FeedbackReasons.ApiError,
                _ => throw new UnreachableException(),
            };
            return Failed(reason, ex.Failure == FeedbackFailure.Timeout ? "timeout" : "error", ex.Cause ?? ex.GetType().Name, ex.StatusCode, started);
        }

        var latency = time.GetElapsedTime(started).TotalMilliseconds;
        if (!IsMock)
        {
            budget.Record(reply.Usage);
            foreach (var usage in reply.Usage)
            {
                metrics.Tokens(usage);
            }
        }

        var (feedback, outcome, why) = reply.StopReason switch
        {
            "refusal" => ((PositionFeedback?)null, "refusal", FeedbackReasons.Refusal),
            "max_tokens" => (null, "invalid-response", FeedbackReasons.Truncated),
            "end_turn" => FeedbackGrounding.Ground(reply.Text, planMetrics) is { } grounded
                ? (grounded, "ok", (string?)null)
                : (null, "invalid-response", FeedbackReasons.InvalidResponse),
            _ => (null, "invalid-response", FeedbackReasons.InvalidResponse),
        };
        metrics.Outcome(model.Provider, outcome, latency);
        long input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
        foreach (var usage in reply.Usage)
        {
            (input, output, cacheWrite, cacheRead) = (input + usage.InputTokens, output + usage.OutputTokens, cacheWrite + usage.CacheWriteTokens, cacheRead + usage.CacheReadTokens);
        }

        Log.Called(logger, model.Provider, ModelName, outcome, latency, input, output, cacheWrite, cacheRead, reply.StopReason);
        return (feedback, why);
    }

    // The cause is a type name and an HTTP status, so a revoked key (401), a refused request (400), an unreadable reply
    // and our own bug log differently. Neither carries a message or a body.
    private (PositionFeedback?, string?) Failed(string reason, string outcome, string cause, int? status, long started)
    {
        var latency = time.GetElapsedTime(started).TotalMilliseconds;
        metrics.Outcome(model.Provider, outcome, latency);
        var http = status is { } code ? string.Create(CultureInfo.InvariantCulture, $"HTTP {code}") : "no HTTP status";
        Log.Failed(logger, model.Provider, ModelName, reason, latency, cause, http);
        return (null, reason);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Information, Message = "Feedback call {Provider} {Model} {Outcome} in {LatencyMs:0} ms: input {InputTokens}, output {OutputTokens}, cache write {CacheWriteTokens}, cache read {CacheReadTokens}, stop {StopReason}")]
        public static partial void Called(ILogger logger, string provider, string model, string outcome, double latencyMs, long inputTokens, long outputTokens, long cacheWriteTokens, long cacheReadTokens, string stopReason);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Feedback call {Provider} {Model} failed {Outcome} after {LatencyMs:0} ms: {ExceptionType}, {HttpStatus}")]
        public static partial void Failed(ILogger logger, string provider, string model, string outcome, double latencyMs, string exceptionType, string httpStatus);
    }
}
