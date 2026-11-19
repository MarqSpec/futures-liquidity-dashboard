using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// reference: REQUIREMENTS.md NFR-6 (the key comes only from Feedback__ApiKey or ANTHROPIC_API_KEY)
public sealed class FeedbackServiceCollectionExtensionsTests
{
    [Fact]
    public void AddPositionFeedback_ShouldReadTheKeyFromAnthropicApiKey_WhenFeedbackApiKeyIsEmpty()
    {
        using var services = Build(new() { ["ANTHROPIC_API_KEY"] = FeedbackTestData.SyntheticKey });

        services.GetRequiredService<IOptions<FeedbackOptions>>().Value.ApiKey.Should().Be(FeedbackTestData.SyntheticKey);
    }

    [Fact]
    public void AddPositionFeedback_ShouldPreferFeedbackApiKey_WhenBothAreSet()
    {
        using var services = Build(new() { ["ANTHROPIC_API_KEY"] = "sk-ant-other", ["Feedback:ApiKey"] = FeedbackTestData.SyntheticKey });

        services.GetRequiredService<IOptions<FeedbackOptions>>().Value.ApiKey.Should().Be(FeedbackTestData.SyntheticKey);
    }

    [Fact]
    public void AddPositionFeedback_ShouldStayDisabledOnClaude_WhenNothingIsConfigured()
    {
        using var services = Build([]);

        var options = services.GetRequiredService<IOptions<FeedbackOptions>>().Value;
        (options.Enabled, options.Provider, options.Model, options.Effort, options.MonthlyBudgetUsd).Should().Be((false, FeedbackProvider.Claude, "claude-opus-5-5", "medium", 100m));
        services.GetRequiredService<IFeedbackModel>().Should().BeOfType<ClaudeFeedbackModel>();
    }

    [Fact]
    public void AddPositionFeedback_ShouldUseTheMock_WhenTheProviderIsMock()
    {
        using var services = Build(new() { ["Feedback:Provider"] = "Mock" });

        services.GetRequiredService<IFeedbackModel>().Should().BeOfType<MockFeedbackModel>();
    }

    [Theory]
    [InlineData("Feedback:Model", "claude-unpriced")]
    [InlineData("Feedback:Effort", "extreme")]
    [InlineData("Feedback:BaseUrl", "http://api.anthropic.com")]
    [InlineData("Feedback:MonthlyBudgetUsd", "-1")]
    public void AddPositionFeedback_ShouldRefuseToStartWithoutNamingTheKey_WhenASettingIsInvalid(string key, string value)
    {
        using var services = Build(new() { [key] = value, ["Feedback:ApiKey"] = FeedbackTestData.SyntheticKey });

        var act = () => services.GetRequiredService<IOptions<FeedbackOptions>>().Value;

        act.Should().Throw<OptionsValidationException>().Which.ToString().Should().NotContain(FeedbackTestData.SyntheticKey);
    }

    [Fact]
    public void AddPositionFeedback_ShouldStart_WhenEnabledOnClaudeWithNoKey()
    {
        using var services = Build(new() { ["Feedback:Enabled"] = "true" });

        services.GetRequiredService<IOptions<FeedbackOptions>>().Value.HasKey.Should().BeFalse();
    }

    private static ServiceProvider Build(Dictionary<string, string?> settings)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection().AddLogging().AddMetrics();
        services.AddSingleton(TimeProvider.System);
        services.AddPositionFeedback(configuration);
        return services.BuildServiceProvider();
    }
}
