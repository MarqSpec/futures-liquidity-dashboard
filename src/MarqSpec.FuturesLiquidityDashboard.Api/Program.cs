using System.Text.Json;
using System.Text.Json.Serialization;
using MarqSpec.FuturesLiquidityDashboard.Api.Agent;
using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using MarqSpec.FuturesLiquidityDashboard.Api.Endpoints;
using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using MarqSpec.FuturesLiquidityDashboard.Api.Health;
using MarqSpec.FuturesLiquidityDashboard.Api.Hubs;
using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;
using MarqSpec.FuturesLiquidityDashboard.Api.Telemetry;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using MarqSpec.FuturesLiquidityDashboard.Api.ProjectX;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;

if (LiveSmokeCommand.IsRequested(args))
{
    Environment.ExitCode = await LiveSmokeCommand.RunAsync(args);
    return;
}

var builder = WebApplication.CreateBuilder(args);

// The hub key travels in the query string. Redact it from formatted lines, structured state and exceptions (ARCHITECTURE.md D-30).
builder.Logging.RedactSecrets();

// Engines, the configured feed (synthetic by default in Development; ProjectX in production) and ingestion.
builder.Services.AddMarketData(builder.Configuration);

builder.Services.AddSingleton(sp =>
{
    var registry = sp.GetRequiredService<EngineRegistry>();
    return new OverlayStore(
        sp.GetRequiredService<TimeProvider>(),
        root => registry.TryGet(root, out var engine) ? engine.Spec : InstrumentCatalog.For(root));
});
// Saved layouts, kept in one file across restarts; market state is not (ARCHITECTURE.md D-18).
builder.Services.AddLayoutStore(builder.Configuration);
builder.Services.AddSingleton<BrowserSendGate>();
builder.Services.AddSingleton<WatchTracker>();
builder.Services.AddSingleton<DashboardMetrics>();
builder.Services.AddHostedService<MarketPublisher>();
builder.Services.AddHostedService<ReferenceOverlayAgent>();

// Position feedback on request: Claude in the API, or the deterministic mock in Development (ARCHITECTURE.md D-61).
builder.Services.AddPositionFeedback(builder.Configuration);

// Viewer and agent access: API keys (ARCHITECTURE.md D-16), and sign-in through an OpenID Connect provider when
// Auth:Oidc:Enabled is true (D-77).
builder.Services.AddDashboardAuth(builder.Configuration, builder.Environment);

// One JSON shape for HTTP and SignalR: camelCase, enums as strings (INTERFACES.md D.2).
static void ConfigureJson(JsonSerializerOptions o)
{
    o.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.Converters.Add(new JsonStringEnumConverter());
    o.NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals;
}

builder.Services.ConfigureHttpJsonOptions(o => ConfigureJson(o.SerializerOptions));
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 64 * 1024)
    .AddJsonProtocol(o => ConfigureJson(o.PayloadSerializerOptions));

builder.Services.AddHealthChecks().AddCheck<IngestionHealthCheck>("ingestion", tags: ["ready"]);

// Metrics for Prometheus at GET /metrics (OBSERVABILITY.md §2).
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("futuresliquiditydashboard.api"))
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddMeter(DashboardMetrics.MeterName)
        .AddPrometheusExporter());

builder.Services.AddOpenApi();

var app = builder.Build();

// Create the gauges with the app, so /metrics has them from the first scrape.
_ = app.Services.GetRequiredService<DashboardMetrics>();
_ = app.Services.GetRequiredService<IngestMetrics>();
_ = app.Services.GetRequiredService<DepthWidthDiagnostic>();
_ = app.Services.GetRequiredService<FeedbackMetrics>();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseAuthentication();
app.UseAuthorization();

// Liveness stays anonymous for the platform check. Detailed readiness and metrics name every instrument's
// LIVE/STALE/RECOVERING state, so outside Development they require a key unless Auth:ProtectDiagnostics is false.
// That flag is read once here; changing it needs a process restart (D-30).
var protectDiagnostics = app.Services.GetRequiredService<IOptions<AuthOptions>>().Value
    .RequiresKeyForDiagnostics(app.Environment.IsDevelopment());

app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false }).AllowAnonymous();
var ready = app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = c => c.Tags.Contains("ready"),
    ResponseWriter = HealthResponse.WriteAsync,
});
if (protectDiagnostics)
{
    ready.RequireAuthorization();
}

app.MapAuthConfig();
app.MapDashboardApi();
app.MapPlanFeedback();
app.MapHub<MarketHub>(MarketHub.Path);
var metrics = app.MapPrometheusScrapingEndpoint();
var depthWidth = app.MapDepthWidth();
if (protectDiagnostics)
{
    metrics.RequireAuthorization();
    depthWidth.RequireAuthorization();
}

// An unmatched path still has to challenge. Otherwise a lookalike such as /hubsx?access_token=... is only a 404
// whether or not the query token was ignored, and the hub-segment check cannot be seen from HTTP (D-30).
app.MapFallback(() => Results.NotFound()).RequireAuthorization();

await app.RunAsync().ConfigureAwait(false);

/// <summary>The entry point, public so the integration tests can host it with WebApplicationFactory.</summary>
public partial class Program;
