using System.Globalization;
using System.Security.Claims;
using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using Microsoft.AspNetCore.Http.HttpResults;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Endpoints;


/// <summary>
/// Position feedback (REQUIREMENTS.md FR-74; INTERFACES.md D.1; ARCHITECTURE.md D-61). The routes say <c>plans</c> and
/// <c>feedback</c>, so no route carries an order word and the FR-6 guard holds unchanged. Feedback runs only when asked.
/// </summary>
public static class FeedbackEndpoints
{
    public static IEndpointRouteBuilder MapPlanFeedback(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var api = app.MapGroup("/api/plans/feedback").RequireAuthorization();

        // Any request-feedback grant may read whether feedback is available; it names no instrument.
        api.MapGet("/status", Results<Ok<FeedbackStatus>, ForbidHttpResult> (ClaimsPrincipal user, FeedbackService feedback) =>
            HoldsAny(user, Permissions.RequestFeedback) ? TypedResults.Ok(feedback.Status()) : TypedResults.Forbid());

        api.MapPost("/{instrument}", async Task<IResult> (
            string instrument,
            SimulatedPosition body,
            ClaimsPrincipal user,
            EngineRegistry registry,
            OverlayStore overlays,
            IngestionState ingestion,
            FeedbackService feedback,
            TimeProvider time,
            HttpContext http,
            CancellationToken cancellationToken) =>
        {
            if (!DashboardEndpoints.TryEngine(instrument, registry, out var engine))
            {
                return TypedResults.NotFound();
            }

            // The reply carries the plan's market metrics, so it needs view-dashboard as well as the feedback grant.
            if (!Permissions.Has(user, Permissions.RequestFeedback, engine.Spec.Root) || !Permissions.Has(user, Permissions.ViewDashboard, engine.Spec.Root))
            {
                return TypedResults.Forbid();
            }

            if (feedback.Status() is { Available: false, Reason: FeedbackReasons.Disabled or FeedbackReasons.NoKey } unavailable)
            {
                return TypedResults.Json(unavailable, statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            var errors = DashboardEndpoints.ValidatePlan(body, engine, ingestion);
            if (errors.Count > 0)
            {
                return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["position"] = [.. errors] });
            }

            var plan = DashboardEndpoints.ToPlan(body);
            var metrics = PlanMetricsCalculator.Compute(plan, engine.PlanMarket(overlays.Current(engine.Spec.Root)));
            var outcome = await feedback.RequestAsync(user.Identity?.Name ?? string.Empty, plan, metrics, cancellationToken).ConfigureAwait(false);
            switch (outcome)
            {
                case FeedbackOutcome.Answered answered:
                    return TypedResults.Ok(answered.Reply);
                case FeedbackOutcome.Unavailable unavailableNow:
                    return TypedResults.Json(unavailableNow.Status, statusCode: StatusCodes.Status503ServiceUnavailable);
                case FeedbackOutcome.OverBudget over:
                    http.Response.Headers.RetryAfter = Math.Max(1, (over.Status.ResetsAtMs - time.GetUtcNow().ToUnixTimeMilliseconds()) / 1000).ToString(CultureInfo.InvariantCulture);
                    return TypedResults.Json(over.Status, statusCode: StatusCodes.Status429TooManyRequests);
                case FeedbackOutcome.Refused refused:
                    if (refused.Refusal.RetryAfterSeconds is { } seconds)
                    {
                        http.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
                    }

                    return TypedResults.Json(refused.Refusal, statusCode: StatusCodes.Status429TooManyRequests);
                default:
                    throw new InvalidOperationException("Unknown feedback outcome.");
            }
        });

        return app;
    }

    private static bool HoldsAny(ClaimsPrincipal user, string permission) =>
        user.Claims.Any(c => c.Type == Permissions.ClaimType && c.Value.StartsWith(permission + ":", StringComparison.Ordinal));
}
