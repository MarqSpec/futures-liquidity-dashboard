using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

// A host that kept the shipped defaults would read and write data/feedback-budget.json and data/layouts.json under the
// repository's content root, so one run's state would leak into the next and into the maintainer's own checkout.
[Trait("Deployment", "None")]
public sealed class DashboardFactoryTests
{
    [Fact]
    public void Host_ShouldKeepEveryFileStoreInMemory_WhenBuiltByTheDashboardFactory()
    {
        using var factory = new DashboardFactory();

        AssertNothingPersisted(factory);
    }

    [Fact]
    public void Host_ShouldKeepEveryFileStoreInMemory_WhenBuiltByTheProductionFactory()
    {
        using var factory = new ProductionDashboardFactory();

        AssertNothingPersisted(factory);
    }

    private static void AssertNothingPersisted(WebApplicationFactory<Program> factory)
    {
        var feedback = factory.Services.GetRequiredService<IOptions<FeedbackOptions>>().Value;
        var layouts = factory.Services.GetRequiredService<IOptions<LayoutStoreOptions>>().Value;

        feedback.BudgetStorePath.Should().BeNullOrWhiteSpace("a blank Feedback:BudgetStorePath keeps the budget in memory");
        layouts.IsPersistent.Should().BeFalse($"Layouts:StorePath must be blank, not {layouts.StorePath}");
    }
}
