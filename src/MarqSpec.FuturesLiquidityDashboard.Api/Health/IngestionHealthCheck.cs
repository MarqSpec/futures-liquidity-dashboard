using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Health;

/// <summary>
/// Readiness reports the upstream state of every instrument, not just that the process is up
/// (INTERFACES.md D.1, REQUIREMENTS.md NFR-1): unhealthy until history has loaded and the feed is streaming, and
/// degraded while any instrument is not healthy (STALE, RECOVERING, DISCONNECTED).
/// </summary>
public sealed class IngestionHealthCheck(IngestionState state, EngineRegistry registry) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var data = new Dictionary<string, object>
        {
            ["feed"] = state.FeedName,
            ["provenance"] = state.Provenance.ToString(),
            ["restarts"] = state.Restarts,
        };
        var unhealthy = new List<string>();
        foreach (var engine in registry.All)
        {
            var status = engine.Status();
            data[engine.Spec.Root.ToString()] = status.Code;
            if (status.Code is not ("LIVE" or "REPLAY" or "SIMULATED"))
            {
                unhealthy.Add($"{engine.Spec.Root} {status.Code}");
            }
        }

        if (!state.Ready)
        {
            return Task.FromResult(HealthCheckResult.Unhealthy(state.LastError ?? "Ingestion is starting.", data: data));
        }

        return Task.FromResult(unhealthy.Count == 0
            ? HealthCheckResult.Healthy("All instruments healthy.", data)
            : HealthCheckResult.Degraded(string.Join(", ", unhealthy), data: data));
    }
}
