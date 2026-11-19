using System.Globalization;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>
/// Deterministic feedback built only from the computed metrics, for development (<c>Feedback:Provider = Mock</c>): no
/// key, no network, no cost, and a reply marked <c>provider: mock</c>. It writes the same structured output a model
/// would, so it passes through the same grounding. Its likelihoods are a fixed reading of the 60-bar trade-through
/// share (at least 0.5 high, at least 0.2 medium, otherwise low; unknown with no known bar), not a forecast.
/// </summary>
public sealed class MockFeedbackModel : IFeedbackModel
{
    private static readonly string[] StopPlacementCite = ["stopPlacement"];
    private static readonly string[] CoverageCite = ["coverage"];
    private static readonly string[] SlippageCite = ["marketSlippage"];

    public string Provider => "mock";

    public Task<ModelReply> CompleteAsync(FeedbackModelRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        var metrics = request.Metrics;
        var legs = metrics.Legs.Select(leg => Leg(leg, metrics)).ToList();
        var risks = Risks(metrics);
        var firstTarget = metrics.RewardRisk.Count > 0 ? metrics.RewardRisk[0] : null;
        var summary = firstTarget?.Ratio is { } ratio
            ? string.Create(CultureInfo.InvariantCulture, $"Mock feedback from definitions version {metrics.DefinitionsVersion}: reward to risk {ratio:0.##} on the first target.")
            : $"Mock feedback from definitions version {metrics.DefinitionsVersion}: reward to risk is unknown.";
        var json = JsonSerializer.Serialize(new { summary, legs, risks });
        return Task.FromResult(new ModelReply("end_turn", json, []));
    }

    private static object Leg(LegMetrics leg, PlanMetrics metrics)
    {
        var sixty = leg.ThroughFrequency.FirstOrDefault(t => t.Bars == 60);
        var likelihood = sixty?.Share switch
        {
            null => "unknown",
            >= 0.5 => "high",
            >= 0.2 => "medium",
            _ => "low",
        };
        var assessment = sixty?.Share is null
            ? "No known one-minute bar in the last 60, so trade-through is unknown."
            : string.Create(CultureInfo.InvariantCulture, $"Traded strictly through in {sixty.Through} of {sixty.Known} known one-minute bars of the last 60.");
        var cites = new List<string> { "throughFrequency.60" };
        if (leg.DistanceAtr is not null)
        {
            cites.Add("distanceAtr");
        }

        object? suggestion = null;
        if (leg.Leg == "stop" && metrics.StopPlacement.JustInside && metrics.StopPlacement.Near.Count > 0 && leg.PriceTicks is { } stop)
        {
            // One tick beyond the nearest level, on the side away from the entry.
            var near = metrics.StopPlacement.Near.MinBy(n => Math.Abs(n.DistanceTicks))!;
            var beyond = near.PriceTicks < stop ? near.PriceTicks - 1 : near.PriceTicks + 1;
            suggestion = new { priceTicks = beyond, why = $"The stop sits just inside {near.Name}; one tick beyond it is outside the level." };
            cites.Add("stopPlacement");
        }

        return new { leg = leg.Leg, index = leg.Index, fillLikelihood = likelihood, assessment, suggestion, cites };
    }

    private static List<object> Risks(PlanMetrics metrics)
    {
        var risks = new List<object>();
        if (metrics.StopPlacement.JustInside)
        {
            risks.Add(new { text = "The stop sits one or two ticks inside a key level or a wall.", cites = StopPlacementCite });
        }

        if (metrics.Coverage.ProfilePartialSinceMs is not null || metrics.Coverage.VwapPartial || metrics.Coverage.FlowPartial || metrics.Coverage.MissingSinceMs is not null)
        {
            risks.Add(new { text = "Part of the session history is missing or partial.", cites = CoverageCite });
        }

        if (metrics.MarketSlippage?.SlippageTicks is > 0)
        {
            risks.Add(new { text = "A market entry would fill beyond the touch.", cites = SlippageCite });
        }

        return risks;
    }
}
