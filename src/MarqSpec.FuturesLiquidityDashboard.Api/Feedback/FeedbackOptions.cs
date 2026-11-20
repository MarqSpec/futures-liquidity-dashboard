namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>Who writes the feedback: the Claude Messages API, or a deterministic stand-in for development.</summary>
public enum FeedbackProvider
{
    Claude,
    Mock,
}

/// <summary>
/// Position feedback settings (<c>Feedback:*</c>; REQUIREMENTS.md FR-74; ARCHITECTURE.md D-61). Validated at start. The API key is
/// read from <c>Feedback:ApiKey</c> or, when that is empty, <c>ANTHROPIC_API_KEY</c>, both from the environment; it is
/// never logged, returned or put in an exception message (NFR-6).
/// </summary>
public sealed class FeedbackOptions
{
    public const string Section = "Feedback";

    /// <summary>The environment variable the key falls back to when <see cref="ApiKey"/> is empty.</summary>
    public const string ApiKeyVariable = "ANTHROPIC_API_KEY";

    /// <summary>The efforts the Messages API accepts on the default model.</summary>
    public static IReadOnlySet<string> Efforts { get; } = new HashSet<string>(StringComparer.Ordinal) { "low", "medium", "high", "xhigh", "max" };

    /// <summary>False hides the feature: both routes answer that feedback is unavailable.</summary>
    public bool Enabled { get; set; }

    public FeedbackProvider Provider { get; set; } = FeedbackProvider.Claude;

    public string Model { get; set; } = "claude-opus-5-5";

    public string Effort { get; set; } = "medium";

    /// <summary>The output cap, thinking included.</summary>
    public int MaxTokens { get; set; } = 8000;

    /// <summary>The whole call's deadline, retries included.</summary>
    public int TimeoutSeconds { get; set; } = 60;

    /// <summary>The month's spend cap in US dollars, counted from usage and kept in <see cref="BudgetStorePath"/>.</summary>
    public decimal MonthlyBudgetUsd { get; set; } = 100m;

    /// <summary>
    /// The JSON file that keeps the month, its spend and the cap across a restart: relative to the content root, or
    /// absolute (the container sets <c>/data/feedback-budget.json</c>). Blank keeps the count in memory only. One replica.
    /// </summary>
    public string BudgetStorePath { get; set; } = "data/feedback-budget.json";

    /// <summary>Requests one viewer may start in any sliding minute.</summary>
    public int RequestsPerMinute { get; set; } = 6;

    /// <summary>The SDK's retries of a 408, 409, 429 or 5xx inside <see cref="TimeoutSeconds"/>, with its backoff.</summary>
    public int MaxRetries { get; set; } = 2;

    /// <summary>Opts in to the server-side refusal fallback (<c>fallbacks: "default"</c>).</summary>
    public bool ServerFallback { get; set; } = true;

    /// <summary>The Messages API base address; HTTPS only. Tests point it at a stub.</summary>
    public Uri BaseUrl { get; set; } = new("https://api.anthropic.com");

    /// <summary>The secret. Set through the environment only, never in a shipped file.</summary>
    public string? ApiKey { get; set; }

    /// <summary>True when a non-blank key is configured.</summary>
    public bool HasKey => !string.IsNullOrWhiteSpace(ApiKey);

    /// <summary>The reasons these settings cannot start, without any secret in them. Empty when valid.</summary>
    public IReadOnlyList<string> Validate()
    {
        var errors = new List<string>();
        if (string.IsNullOrWhiteSpace(Model) || !ModelPrices.IsKnown(Model))
        {
            errors.Add($"Feedback:Model must be one of {string.Join(", ", ModelPrices.Models)}, so its spend can be counted.");
        }

        if (!Efforts.Contains(Effort))
        {
            errors.Add($"Feedback:Effort must be one of {string.Join(", ", Efforts)}.");
        }

        if (MaxTokens is < 1024 or > 64_000)
        {
            errors.Add("Feedback:MaxTokens must be from 1024 to 64000.");
        }

        if (TimeoutSeconds is < 5 or > 300)
        {
            errors.Add("Feedback:TimeoutSeconds must be from 5 to 300.");
        }

        if (MonthlyBudgetUsd < 0)
        {
            errors.Add("Feedback:MonthlyBudgetUsd must not be negative.");
        }

        if (RequestsPerMinute is < 1 or > 60)
        {
            errors.Add("Feedback:RequestsPerMinute must be from 1 to 60.");
        }

        if (MaxRetries is < 0 or > 5)
        {
            errors.Add("Feedback:MaxRetries must be from 0 to 5.");
        }

        if (BaseUrl is null || !BaseUrl.IsAbsoluteUri || BaseUrl.Scheme != Uri.UriSchemeHttps)
        {
            errors.Add("Feedback:BaseUrl must be an absolute https address.");
        }

        return errors;
    }
}
