using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Endpoints;

/// <summary>Read-only received depth width (REQUIREMENTS.md FR-6, FR-11). No prices, no credentials, no broker call.</summary>
public static class DepthWidthEndpoint
{
    public static RouteHandlerBuilder MapDepthWidth(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.MapGet(DepthWidthDiagnostic.Route, (DepthWidthDiagnostic diagnostic) => Results.Ok(diagnostic.Report()));
    }
}
