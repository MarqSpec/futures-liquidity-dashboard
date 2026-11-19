using System.Text;
using Anthropic;
using Anthropic.Exceptions;
using Anthropic.Models.Beta;
using Anthropic.Models.Beta.Messages;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;

// reference: ARCHITECTURE.md D-61 (the official SDK, on request, with a cached static system prompt)

/// <summary>
/// The Claude Messages API behind <see cref="IFeedbackModel"/>, through the official Anthropic C# SDK. One beta call per
/// request: the static system prompt with <c>cache_control</c>, the data-only user message, <c>output_config</c> with
/// the configured effort and the JSON schema, and, when <see cref="FeedbackOptions.ServerFallback"/> is on,
/// <c>fallbacks: "default"</c> under <c>server-side-fallback-2026-07-01</c>. The HttpClient comes from the factory, so
/// certificate validation stays on and tests can fake the transport. A failure surfaces as a
/// <see cref="FeedbackModelException"/> that carries none of what the provider sent back, an unforeseen one included.
/// </summary>
public sealed class ClaudeFeedbackModel(IHttpClientFactory httpClients, IOptions<FeedbackOptions> options) : IFeedbackModel
{
    public const string HttpClientName = "anthropic";

    public string Provider => "claude";

    public async Task<ModelReply> CompleteAsync(FeedbackModelRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        var settings = options.Value;
        var client = new AnthropicClient
        {
            ApiKey = settings.ApiKey,
            BaseUrl = settings.BaseUrl.ToString().TrimEnd('/'),
            HttpClient = httpClients.CreateClient(HttpClientName),
            MaxRetries = settings.MaxRetries,
            Timeout = TimeSpan.FromSeconds(settings.TimeoutSeconds),
        };

        try
        {
            var message = await client.Beta.Messages.Create(Parameters(request, settings), cancellationToken).ConfigureAwait(false);
            // The SDK reads fields lazily, so a malformed reply throws here, not in Create.
            return Reply(message);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // The SDK's message can echo the request or the provider's body: only its type and status are carried on.
            throw new FeedbackModelException(Classify(ex), ex.GetType().Name, Status(ex));
        }
    }

    private static MessageCreateParams Parameters(FeedbackModelRequest request, FeedbackOptions settings)
    {
        var parameters = new MessageCreateParams
        {
            Model = settings.Model,
            MaxTokens = settings.MaxTokens,
            System = new List<BetaTextBlockParam>
            {
                new() { Text = FeedbackPrompt.System, CacheControl = new BetaCacheControlEphemeral() },
            },
            OutputConfig = new BetaOutputConfig
            {
                Effort = settings.Effort switch
                {
                    "low" => Effort.Low,
                    "high" => Effort.High,
                    "xhigh" => Effort.Xhigh,
                    "max" => Effort.Max,
                    _ => Effort.Medium,
                },
                Format = new BetaJsonOutputFormat { Schema = new Dictionary<string, System.Text.Json.JsonElement>(FeedbackPrompt.OutputSchema) },
            },
            Messages = [new BetaUserMessageParam { Content = request.UserMessage }],
        };

        return settings.ServerFallback
            ? parameters with { Betas = [AnthropicBeta.ServerSideFallback2026_07_01], Fallbacks = new BetaFallbacksParam(new Default()) }
            : parameters;
    }

    private static ModelReply Reply(BetaMessage message)
    {
        var text = new StringBuilder();
        foreach (var block in message.Content)
        {
            if (block.TryPickText(out var part))
            {
                text.Append(part.Text);
            }
        }

        var usage = new List<TokenUsage>();
        foreach (var iteration in message.Usage.Iterations ?? [])
        {
            if (iteration.TryPickBetaMessageIterationUsage(out var first))
            {
                usage.Add(new TokenUsage(first.Model ?? message.Model.Raw(), first.InputTokens, first.OutputTokens, first.CacheCreationInputTokens, first.CacheReadInputTokens));
            }
            else if (iteration.TryPickBetaFallbackMessageIterationUsage(out var fallback))
            {
                usage.Add(new TokenUsage(fallback.Model ?? string.Empty, fallback.InputTokens, fallback.OutputTokens, fallback.CacheCreationInputTokens, fallback.CacheReadInputTokens));
            }
        }

        if (usage.Count == 0)
        {
            var u = message.Usage;
            usage.Add(new TokenUsage(message.Model, u.InputTokens, u.OutputTokens, u.CacheCreationInputTokens ?? 0, u.CacheReadInputTokens ?? 0));
        }

        return new ModelReply(message.StopReason?.Raw() ?? string.Empty, text.Length == 0 ? null : text.ToString(), usage);
    }

    private static int? Status(Exception ex) => ex switch
    {
        AnthropicApiException api => (int)api.StatusCode,
        HttpRequestException { StatusCode: { } status } => (int)status,
        _ => null,
    };

    // Anything unforeseen is an API error, so the caller still gets the metrics (FR-74), never a 500.
    private static FeedbackFailure Classify(Exception ex) => ex switch
    {
        AnthropicRateLimitException => FeedbackFailure.RateLimited,
        Anthropic5xxException => FeedbackFailure.ServerError,
        AnthropicIOException or HttpRequestException => FeedbackFailure.Connection,
        OperationCanceledException or TimeoutException => FeedbackFailure.Timeout,
        _ => FeedbackFailure.ApiError,
    };
}
