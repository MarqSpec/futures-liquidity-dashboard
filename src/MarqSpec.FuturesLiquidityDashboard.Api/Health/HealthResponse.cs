using System.Text.Json;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Health;

/// <summary>Writes readiness as JSON with each instrument's status, so an operator sees which one is unhealthy.</summary>
public static class HealthResponse
{
    public static Task WriteAsync(HttpContext context, HealthReport report)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(report);
        context.Response.ContentType = "application/json";
        var body = new
        {
            status = report.Status.ToString(),
            checks = report.Entries.ToDictionary(e => e.Key, e => new
            {
                status = e.Value.Status.ToString(),
                description = e.Value.Description,
                data = e.Value.Data,
            }),
        };
        return context.Response.WriteAsync(JsonSerializer.Serialize(body));
    }
}
