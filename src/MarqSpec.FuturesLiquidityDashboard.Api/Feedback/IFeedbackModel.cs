using MarqSpec.FuturesLiquidityDashboard.Core.Plans;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>What a model is asked: the computed metrics, and the user message that carries them as data.</summary>
public sealed record FeedbackModelRequest(PlanSpec Plan, PlanMetrics Metrics, string UserMessage);

/// <summary>Tokens one model attempt used, as the Messages API reports them in <c>usage</c>.</summary>
public sealed record TokenUsage(string Model, long InputTokens, long OutputTokens, long CacheWriteTokens, long CacheReadTokens);

/// <summary>A model's answer. <see cref="Text"/> is the structured-output JSON, unvalidated.</summary>
/// <param name="StopReason">The Messages API <c>stop_reason</c>: <c>end_turn</c>, <c>refusal</c>, <c>max_tokens</c>, …</param>
/// <param name="Usage">One entry per attempt, a server-side fallback included; empty for the mock.</param>
public sealed record ModelReply(string StopReason, string? Text, IReadOnlyList<TokenUsage> Usage);

/// <summary>How a model call failed, without anything the provider sent back.</summary>
public enum FeedbackFailure
{
    RateLimited,
    ServerError,
    Connection,
    Timeout,
    ApiError,
}

/// <summary>
/// A failed model call. The message names only the category: the provider's error body and the request are never in it,
/// and it wraps no inner exception that could carry them (CONVENTIONS.md §7). What is safe to log about the
/// cause travels beside it: the original exception's type name and, when the API answered, its HTTP status.
/// </summary>
public sealed class FeedbackModelException : Exception
{
    public FeedbackModelException(FeedbackFailure failure, string? cause = null, int? statusCode = null)
        : base($"The feedback model call failed: {failure}.")
    {
        Failure = failure;
        Cause = cause;
        StatusCode = statusCode;
    }

    public FeedbackModelException()
        : this(FeedbackFailure.ApiError)
    {
    }

    public FeedbackModelException(string message)
        : base(message) => Failure = FeedbackFailure.ApiError;

    public FeedbackModelException(string message, Exception innerException)
        : base(message, innerException) => Failure = FeedbackFailure.ApiError;

    public FeedbackFailure Failure { get; }

    /// <summary>The original exception's type name, for example <c>HttpRequestException</c>; never its message.</summary>
    public string? Cause { get; }

    /// <summary>The HTTP status the API answered with, when it answered; null for a network failure or our own fault.</summary>
    public int? StatusCode { get; }
}

/// <summary>The one seam around the provider, so no test calls the real API.</summary>
public interface IFeedbackModel
{
    /// <summary>The provider's wire name: <c>claude</c> or <c>mock</c>.</summary>
    string Provider { get; }

    /// <summary>Asks for feedback. Throws <see cref="FeedbackModelException"/> on a failed call, and
    /// <see cref="OperationCanceledException"/> when <paramref name="cancellationToken"/> is cancelled.</summary>
    Task<ModelReply> CompleteAsync(FeedbackModelRequest request, CancellationToken cancellationToken);
}
