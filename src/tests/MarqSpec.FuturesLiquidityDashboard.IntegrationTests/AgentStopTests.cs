using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Agent;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

// reference: REQUIREMENTS.md FR-8 acceptance: stopping the agent leaves ingestion and rendering unaffected (old A10)
// This class has its own host (a class fixture), because it stops the agent, and no test in another class may see a host without it.
[Trait("Deployment", "None")]
public sealed class AgentStopTests(DashboardFactory factory) : IClassFixture<DashboardFactory>
{
    [Fact]
    public async Task Ingestion_ShouldKeepAdvancingAndTheSnapshotStayServed_WhenTheReferenceAgentIsStopped()
    {
        using var client = factory.CreateClient();
        await DashboardFactory.WaitUntilReadyAsync(client);
        await WaitForOverlayVersionAsync(client);
        var volumeBefore = await SessionVolumeAsync(client);

        using var stopWithin = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await factory.Services.GetServices<IHostedService>().OfType<ReferenceOverlayAgent>().Single().StopAsync(stopWithin.Token);
        var versionAtStop = await OverlayVersionAsync(client);

        // The agent publishes every 5 s in this host, so a stopped one leaves the overlay on the version it had.
        await Task.Delay(TimeSpan.FromSeconds(7));
        (await OverlayVersionAsync(client)).Should().Be(versionAtStop, "a stopped agent publishes nothing more");
        var volumeAfter = await WaitForVolumeAboveAsync(client, volumeBefore);

        volumeAfter.Should().BeGreaterThan(volumeBefore, "prints keep arriving and counting after the agent stopped");
        using var ready = await client.GetAsync(new Uri("/health/ready", UriKind.Relative));
        ready.IsSuccessStatusCode.Should().BeTrue("readiness is the feed's, not the agent's");
    }

    private static async Task<long> WaitForOverlayVersionAsync(HttpClient client)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            if (await OverlayVersionAsync(client) is { } version)
            {
                return version;
            }

            await Task.Delay(500);
        }

        throw new TimeoutException("The reference agent published no overlay within 30 s.");
    }

    private static async Task<long?> OverlayVersionAsync(HttpClient client)
    {
        using var doc = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/snapshot/MGC?historyMinutes=1", UriKind.Relative)));
        return doc.RootElement.TryGetProperty("overlay", out var overlay) && overlay.ValueKind == JsonValueKind.Object
            ? overlay.GetProperty("version").GetInt64()
            : null;
    }

    private static async Task<long> SessionVolumeAsync(HttpClient client)
    {
        using var doc = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/snapshot/MGC?historyMinutes=1", UriKind.Relative)));
        return doc.RootElement.GetProperty("liquidity").GetProperty("sessionVolume").GetInt64();
    }

    private static async Task<long> WaitForVolumeAboveAsync(HttpClient client, long floor)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        var volume = await SessionVolumeAsync(client);
        while (volume <= floor && DateTime.UtcNow < deadline)
        {
            await Task.Delay(500);
            volume = await SessionVolumeAsync(client);
        }

        return volume;
    }
}
