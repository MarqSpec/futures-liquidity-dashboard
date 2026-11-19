using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// reference: REQUIREMENTS.md FR-74, NFR-9 (a monthly cap counted from usage)
public sealed class FeedbackBudgetTests
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 30, 23, 59, 0, TimeSpan.Zero));

    private FeedbackBudget Budget(decimal cap = 100m) => new(_time, Options.Create(new FeedbackOptions { MonthlyBudgetUsd = cap }));

    [Fact]
    public void Record_ShouldAddTheCostOfEveryAttempt_WhenUsageIsReported()
    {
        var budget = Budget();

        budget.Record([FeedbackTestData.Usage(input: 1_000_000), FeedbackTestData.Usage(input: 0, output: 1_000_000)]);

        budget.Current().SpentUsd.Should().Be(24m);
    }

    [Fact]
    public void Current_ShouldBeExhausted_WhenSpendReachesTheCapExactly()
    {
        var budget = Budget(cap: 8m);
        budget.Record([FeedbackTestData.Usage(input: 1_000_000)]);
        budget.Current().Exhausted.Should().BeFalse();

        budget.Record([FeedbackTestData.Usage(input: 1_000_000)]);

        budget.Current().Should().Be(new BudgetState(8m, 8m, "2026-11", new DateTimeOffset(2026, 12, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds()));
        budget.Current().Exhausted.Should().BeTrue();
    }

    [Fact]
    public void Current_ShouldStartAgainFromZero_WhenTheUtcMonthTurns()
    {
        var budget = Budget(cap: 4m);
        budget.Record([FeedbackTestData.Usage(input: 1_000_000)]);
        budget.Current().Exhausted.Should().BeTrue();

        _time.Advance(TimeSpan.FromMinutes(1));

        budget.Current().Should().Be(new BudgetState(0m, 4m, "2026-12", new DateTimeOffset(2027, 1, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds()));
    }

    [Fact]
    public void CostUsd_ShouldPriceOpus55AtItsListRates_WhenEveryKindOfTokenIsUsed()
    {
        var usage = new TokenUsage("claude-opus-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000);

        ModelPrices.CostUsd(usage).Should().Be(4m + 20m + 5m + 0.2m);
    }

    [Fact]
    public void CostUsd_ShouldPriceAnUnknownModelAtTheHighestRates_WhenAFallbackNamesOne()
    {
        var known = ModelPrices.Models.Max(m => ModelPrices.CostUsd(new TokenUsage(m, 1_000_000, 1_000_000, 0, 0)));

        ModelPrices.CostUsd(new TokenUsage("claude-unlisted", 1_000_000, 1_000_000, 0, 0)).Should().Be(known);
        known.Should().BeGreaterThan(24m);
    }
}
