using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>Registers position feedback (REQUIREMENTS.md FR-74; ARCHITECTURE.md D-61).</summary>
public static class FeedbackServiceCollectionExtensions
{
    /// <summary>
    /// Binds <c>Feedback:*</c>, validated at start; takes the key from <c>ANTHROPIC_API_KEY</c> when <c>Feedback:ApiKey</c>
    /// is empty; and registers the provider the settings name. A missing key does not stop startup: feedback is then
    /// unavailable, and both routes say so.
    /// </summary>
    public static IServiceCollection AddPositionFeedback(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        services.AddOptions<FeedbackOptions>()
            .Bind(configuration.GetSection(FeedbackOptions.Section))
            .PostConfigure(o =>
            {
                if (!o.HasKey)
                {
                    o.ApiKey = configuration[FeedbackOptions.ApiKeyVariable];
                }
            })
            .ValidateOnStart();
        services.AddSingleton<IValidateOptions<FeedbackOptions>, FeedbackOptionsValidator>();

        services.TryAddSingleton(TimeProvider.System);
        services.AddHttpClient(ClaudeFeedbackModel.HttpClientName);
        services.AddSingleton<FeedbackBudget>();
        services.AddSingleton<FeedbackGate>();
        services.AddSingleton<FeedbackMetrics>();
        services.AddSingleton<ClaudeFeedbackModel>();
        services.AddSingleton<MockFeedbackModel>();
        services.AddSingleton<IFeedbackModel>(sp => sp.GetRequiredService<IOptions<FeedbackOptions>>().Value.Provider switch
        {
            FeedbackProvider.Mock => sp.GetRequiredService<MockFeedbackModel>(),
            FeedbackProvider.Claude => sp.GetRequiredService<ClaudeFeedbackModel>(),
            _ => throw new InvalidOperationException("Feedback:Provider must be Claude or Mock."),
        });
        services.AddSingleton<FeedbackService>();
        return services;
    }

    // Names every invalid setting, never a value.
    private sealed class FeedbackOptionsValidator : IValidateOptions<FeedbackOptions>
    {
        public ValidateOptionsResult Validate(string? name, FeedbackOptions options)
        {
            var errors = options.Validate();
            return errors.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(errors);
        }
    }
}
