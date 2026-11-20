using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Time.Testing;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// reference: REQUIREMENTS.md NFR-6 (the key comes only from Feedback__ApiKey or ANTHROPIC_API_KEY)
public sealed class FeedbackServiceCollectionExtensionsTests
{
    private static readonly string Root = Path.GetFullPath(Path.Combine(Path.DirectorySeparatorChar.ToString(), "srv", "api"));

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

    [Fact]
    public void AddPositionFeedback_ShouldResumeTheCount_WhenTheHostRestartsInTheSameMonth()
    {
        var disk = new FakeBudgetFiles();
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 11, 10, 12, 0, 0, TimeSpan.Zero));
        using (var first = BuildWithDisk(disk, time, [], Root))
        {
            first.GetRequiredService<FeedbackBudget>().Record([FeedbackTestData.Usage(input: 1_000_000)]);
        }

        using var restarted = BuildWithDisk(disk, time, [], Root);

        restarted.GetRequiredService<FeedbackBudget>().Current().SpentUsd.Should().Be(4m);
    }

    [Fact]
    public void AddPositionFeedback_ShouldResolveARelativePathAgainstTheContentRoot_WhenTheStoreIsConfigured()
    {
        var disk = new FakeBudgetFiles();
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 11, 10, 12, 0, 0, TimeSpan.Zero));
        using var services = BuildWithDisk(disk, time, new() { ["Feedback:BudgetStorePath"] = "state/budget.json" }, Root);

        services.GetRequiredService<FeedbackBudget>().Record([FeedbackTestData.Usage(input: 1_000_000)]);

        disk.Files.Keys.Should().BeEquivalentTo(Path.GetFullPath("state/budget.json", Root));
    }

    [Fact]
    public void AddPositionFeedback_ShouldUseTheDefaultPathUnderTheContentRoot_WhenNothingIsConfigured()
    {
        var disk = new FakeBudgetFiles();
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 11, 10, 12, 0, 0, TimeSpan.Zero));
        using var services = BuildWithDisk(disk, time, [], Root);

        services.GetRequiredService<FeedbackBudget>().Record([FeedbackTestData.Usage(input: 1_000_000)]);

        disk.Files.Keys.Should().BeEquivalentTo(Path.GetFullPath("data/feedback-budget.json", Root));
    }

    [Fact]
    public void AddPositionFeedback_ShouldKeepTheCountInMemoryOnly_WhenThePathIsBlank()
    {
        var disk = new FakeBudgetFiles();
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 11, 10, 12, 0, 0, TimeSpan.Zero));
        using (var first = BuildWithDisk(disk, time, new() { ["Feedback:BudgetStorePath"] = string.Empty }, Root))
        {
            first.GetRequiredService<FeedbackBudget>().Record([FeedbackTestData.Usage(input: 1_000_000)]);
            first.GetRequiredService<FeedbackBudget>().Current().SpentUsd.Should().Be(4m);
        }

        using var restarted = BuildWithDisk(disk, time, new() { ["Feedback:BudgetStorePath"] = string.Empty }, Root);

        disk.Operations.Should().BeEmpty();
        restarted.GetRequiredService<FeedbackBudget>().Current().SpentUsd.Should().Be(0m);
    }

    private static ServiceProvider BuildWithDisk(FakeBudgetFiles disk, TimeProvider time, Dictionary<string, string?> settings, string contentRoot)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection().AddLogging().AddMetrics();
        services.AddSingleton(time);
        services.AddSingleton<IFeedbackBudgetFiles>(disk);
        var environment = A.Fake<IHostEnvironment>();
        A.CallTo(() => environment.ContentRootPath).Returns(contentRoot);
        services.AddSingleton(environment);
        services.AddPositionFeedback(configuration);
        return services.BuildServiceProvider();
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
