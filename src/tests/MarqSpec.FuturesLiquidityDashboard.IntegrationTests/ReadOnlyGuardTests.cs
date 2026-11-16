using System.Reflection;
using MarqSpec.FuturesLiquidityDashboard.Api.Hubs;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

// reference: REQUIREMENTS.md FR-6 (read-only product: no order capability in any route, hub method or permission)
[Trait("Deployment", "None")]
public sealed class ReadOnlyGuardTests(DashboardFactory factory) : IClassFixture<DashboardFactory>
{
    private static readonly string[] OrderWords = ["order", "trade", "execute", "position", "account", "cancel", "flatten"];

    [Fact]
    public void NoRoute_OffersAnOrderCapability()
    {
        using var client = factory.CreateClient();
        var routes = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Select(e => e.RoutePattern.RawText ?? string.Empty)
            .ToList();

        routes.Should().NotBeEmpty();
        routes.Should().NotContain(r => OrderWords.Any(w => r.Contains(w, StringComparison.OrdinalIgnoreCase)));
    }

    [Fact]
    public void NoHubMethod_OffersAnOrderCapability()
    {
        var methods = typeof(MarketHub).GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Select(m => m.Name)
            .ToList();

        // SetWatchlist only chooses which products get depth (REQUIREMENTS.md FR-54). SetIndicatorTimeframe only chooses
        // which indicator series that viewer receives. OnDisconnectedAsync lets go of them.
        methods.Should().BeEquivalentTo(
            ["Subscribe", "SetIndicatorTimeframe", "Unsubscribe", "SetWatchlist", "OnDisconnectedAsync"]);
    }

    [Fact]
    public void EveryTestClass_CarriesADeploymentTrait()
    {
        // integration-qa.md: a class without a staging fixture must say which deployment it needs.
        var classes = typeof(ReadOnlyGuardTests).Assembly.GetTypes()
            .Where(t => t.GetMethods().Any(m => m.GetCustomAttributes<FactAttribute>().Any()));
        foreach (var type in classes)
        {
            type.GetCustomAttributes<TraitAttribute>().Should().NotBeEmpty($"{type.Name} needs a Deployment trait");
        }
    }
}
