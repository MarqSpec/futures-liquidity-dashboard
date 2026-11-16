using System.Security.Claims;
using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Levels;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using Microsoft.AspNetCore.Http.HttpResults;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Endpoints;

/// <summary>
/// The HTTP surface (INTERFACES.md Interfaces C and D.1). Every route checks its permission for the
/// instrument in the path; none of them reads raw book events, exposes credentials or trades (REQUIREMENTS.md FR-6).
/// </summary>
public static class DashboardEndpoints
{
    /// <summary>
    /// One product on GET /api/instruments: the Overview row (REQUIREMENTS.md FR-55, FR-57) and the tab quote
    /// (last, session change, VWAP distance, nearest key level; ARCHITECTURE.md D-28).
    /// </summary>
    public sealed record InstrumentSummary(
        InstrumentInfo Instrument,
        StatusDto Status,
        MarketSummaryDto Summary,
        long? LastTicks,
        long? OpenTicks,
        long? ChangeTicks,
        double? VwapTicks,
        double? VwapStdDev,
        string? NearestLevel,
        long? NearestDistanceTicks,
        int NearestTouches,
        bool NearestIsThirdTouch,
        IReadOnlyList<LevelTouch> Levels);


    public sealed record OverlayAccepted(string Root, long Version, string Publisher, DateTimeOffset AvailableAt);

    public static IEndpointRouteBuilder MapDashboardApi(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/instruments", (ClaimsPrincipal user, EngineRegistry registry) =>
            registry.All
                .Where(e => Permissions.Has(user, Permissions.ViewDashboard, e.Spec.Root))
                .Select(e =>
                {
                    var quote = e.Quote();
                    return new InstrumentSummary(
                        quote.Instrument,
                        quote.Status,
                        e.Summary(),
                        quote.LastTicks,
                        quote.OpenTicks,
                        quote.ChangeTicks,
                        quote.VwapTicks,
                        quote.VwapStdDev,
                        quote.NearestLevel,
                        quote.NearestDistanceTicks,
                        quote.NearestTouches,
                        quote.NearestIsThirdTouch,
                        quote.Levels);
                })
                .ToList());

        api.MapGet("/snapshot/{instrument}", Results<Ok<DashboardSnapshot>, NotFound, ForbidHttpResult> (
            string instrument, int? historyMinutes, int? indicatorMinutes, ClaimsPrincipal user, EngineRegistry registry, OverlayStore overlays) =>
        {
            if (!TryEngine(instrument, registry, out var engine))
            {
                return TypedResults.NotFound();
            }

            if (!Permissions.Has(user, Permissions.ViewDashboard, engine.Spec.Root))
            {
                return TypedResults.Forbid();
            }

            var snapshot = engine.Snapshot(Math.Max(1, historyMinutes ?? 60), overlays.Current(engine.Spec.Root));
            // Omitted keeps every series the engine holds. A value selects one timeframe, as the hub does.
            return TypedResults.Ok(indicatorMinutes is { } requested ? snapshot.ForIndicatorMinutes(requested) : snapshot);
        });

        api.MapGet("/context/{instrument}", Results<Ok<AgentContext>, NotFound, ForbidHttpResult> (
            string instrument, ClaimsPrincipal user, EngineRegistry registry) =>
        {
            if (!TryEngine(instrument, registry, out var engine))
            {
                return TypedResults.NotFound();
            }

            return Permissions.Has(user, Permissions.ReadContext, engine.Spec.Root)
                ? TypedResults.Ok(engine.Context())
                : TypedResults.Forbid();
        });

        api.MapGet("/overlays/{instrument}", Results<Ok<OverlayRequest>, NoContent, NotFound, ForbidHttpResult> (
            string instrument, ClaimsPrincipal user, EngineRegistry registry, OverlayStore overlays) =>
        {
            if (!TryEngine(instrument, registry, out var engine))
            {
                return TypedResults.NotFound();
            }

            if (!Permissions.Has(user, Permissions.ViewDashboard, engine.Spec.Root))
            {
                return TypedResults.Forbid();
            }

            return overlays.Current(engine.Spec.Root) is { } current ? TypedResults.Ok(current.Request) : TypedResults.NoContent();
        });

        api.MapPost("/overlays/{instrument}", Results<Ok<OverlayAccepted>, UnprocessableEntity<ProblemDetailsBody>, NotFound, ForbidHttpResult> (
            string instrument, OverlayRequest request, ClaimsPrincipal user, EngineRegistry registry, OverlayStore overlays) =>
        {
            if (!TryEngine(instrument, registry, out var engine))
            {
                return TypedResults.NotFound();
            }

            if (!Permissions.Has(user, Permissions.PublishOverlay, engine.Spec.Root))
            {
                return TypedResults.Forbid();
            }

            var result = overlays.Publish(engine.Spec.Root, request, user.Identity?.Name ?? "unknown");
            return result.Accepted && result.Overlay is { } overlay
                ? TypedResults.Ok(new OverlayAccepted(engine.Spec.Root.ToString(), overlay.Request.Version, overlay.Publisher, overlay.AvailableAt))
                : TypedResults.UnprocessableEntity(new ProblemDetailsBody(result.Rejection.ToString(), result.Message));
        });

        api.MapGet("/layouts/me", Results<Ok<LayoutDocument>, ForbidHttpResult> (ClaimsPrincipal user, LayoutStore layouts) =>
            HasAny(user, Permissions.ViewDashboard)
                ? TypedResults.Ok(layouts.Get(user.Identity?.Name ?? string.Empty))
                : TypedResults.Forbid());

        // indicatorMinutes is a viewer preference. The engines keep every timeframe; the hub sends one connection
        // the series it subscribed with. A save must not retune shared engine state.
        api.MapPut("/layouts/me", Results<Ok<LayoutDocument>, Conflict<LayoutDocument>, ValidationProblem, ForbidHttpResult> (
            LayoutWrite body, ClaimsPrincipal user, LayoutStore layouts) =>
        {
            if (body.Layout is null)
            {
                return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["layout"] = ["Layout is required."] });
            }

            if (!InstrumentCatalog.TryParse(body.Layout.Instrument, out var root) || !Permissions.Has(user, Permissions.ConfigureLayout, root))
            {
                return TypedResults.Forbid();
            }

            var userName = user.Identity?.Name ?? string.Empty;
            var layout = body.Layout.PreservingStoredOmissions(layouts.Get(userName).Layout);
            var errors = layout.Validate();
            if (errors.Count > 0)
            {
                return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["layout"] = [.. errors] });
            }

            var saved = layouts.Save(userName, layout, body.Revision);
            return saved.Applied ? TypedResults.Ok(saved.Document) : TypedResults.Conflict(saved.Document);
        });

        return app;
    }

    /// <summary>A rejection reason and message, for an overlay the store refused.</summary>
    public sealed record ProblemDetailsBody(string Reason, string Message);

    private static bool TryEngine(string instrument, EngineRegistry registry, out InstrumentEngine engine)
    {
        engine = null!;
        return InstrumentCatalog.TryParse(instrument, out var root) && registry.TryGet(root, out engine);
    }

    private static bool HasAny(ClaimsPrincipal user, string permission) =>
        user.Claims.Any(c => c.Type == Permissions.ClaimType && c.Value.StartsWith(permission + ":", StringComparison.Ordinal));
}
