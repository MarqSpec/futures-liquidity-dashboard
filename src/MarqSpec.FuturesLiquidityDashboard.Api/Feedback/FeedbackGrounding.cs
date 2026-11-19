using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>
/// Validates a model's structured output against <see cref="FeedbackPrompt.OutputSchema"/> and the metrics it was given
/// (REQUIREMENTS.md FR-74). The schema is enforced again here because the API's constrained decoding is not this server's
/// guarantee. A cite that names no FR-73 metric is dropped; a leg claim or risk left with no cite is dropped; a leg
/// that matches no leg of the plan, or repeats one, is dropped; a suggestion beyond the FR-72 tick range is dropped.
/// Every drop counts once in <see cref="PositionFeedback.DroppedCites"/>.
/// </summary>
public static class FeedbackGrounding
{
    public const int SummaryMax = 2000;
    public const int TextMax = 1000;
    private const long TickLimit = 1_000_000_000;

    private static readonly HashSet<string> Likelihoods = new(StringComparer.Ordinal) { "low", "medium", "high", "unknown" };

    /// <summary>The grounded feedback, or null when the output fails the schema.</summary>
    public static PositionFeedback? Ground(string? json, PlanMetrics metrics)
    {
        ArgumentNullException.ThrowIfNull(metrics);
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(json);
            return Ground(doc.RootElement, metrics);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static PositionFeedback? Ground(JsonElement root, PlanMetrics metrics)
    {
        if (root.ValueKind != JsonValueKind.Object
            || !TryText(root, "summary", SummaryMax, out var summary)
            || !root.TryGetProperty("legs", out var legsJson) || legsJson.ValueKind != JsonValueKind.Array
            || !root.TryGetProperty("risks", out var risksJson) || risksJson.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var dropped = 0;
        var legs = new Dictionary<(string Leg, int? Index), LegFeedback>();
        foreach (var item in legsJson.EnumerateArray())
        {
            if (!TryLeg(item, out var leg, ref dropped))
            {
                return null;
            }

            var known = metrics.Legs.Any(m => m.Leg == leg.Leg && m.Index == leg.Index);
            if (!known || legs.ContainsKey((leg.Leg, leg.Index)))
            {
                dropped++;
                continue;
            }

            if (leg.Cites.Count == 0)
            {
                dropped++;
                continue;
            }

            legs[(leg.Leg, leg.Index)] = leg;
        }

        var risks = new List<FeedbackRisk>();
        foreach (var item in risksJson.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !TryText(item, "text", TextMax, out var text) || !TryCites(item, out var cites, ref dropped))
            {
                return null;
            }

            if (cites.Count == 0)
            {
                dropped++;
                continue;
            }

            risks.Add(new FeedbackRisk(text, cites));
        }

        var ordered = metrics.Legs
            .Select(m => legs.GetValueOrDefault((m.Leg, m.Index)))
            .OfType<LegFeedback>()
            .ToList();
        return new PositionFeedback(summary, ordered, risks, metrics.AsOfMs, metrics.DefinitionsVersion, dropped);
    }

    private static bool TryLeg(JsonElement item, out LegFeedback leg, ref int dropped)
    {
        leg = null!;
        if (item.ValueKind != JsonValueKind.Object
            || !item.TryGetProperty("leg", out var name) || name.ValueKind != JsonValueKind.String
            || name.GetString() is not ("entry" or "stop" or "target")
            || !item.TryGetProperty("index", out var indexJson)
            || !item.TryGetProperty("fillLikelihood", out var likelihood) || likelihood.ValueKind != JsonValueKind.String
            || !Likelihoods.Contains(likelihood.GetString()!)
            || !TryText(item, "assessment", TextMax, out var assessment)
            || !item.TryGetProperty("suggestion", out var suggestionJson)
            || !TryCites(item, out var cites, ref dropped))
        {
            return false;
        }

        int? index;
        switch (indexJson.ValueKind)
        {
            case JsonValueKind.Null:
                index = null;
                break;
            case JsonValueKind.Number when indexJson.TryGetInt32(out var i):
                index = i;
                break;
            default:
                return false;
        }

        FeedbackSuggestion? suggestion = null;
        if (suggestionJson.ValueKind == JsonValueKind.Object)
        {
            if (!suggestionJson.TryGetProperty("priceTicks", out var price) || price.ValueKind != JsonValueKind.Number
                || !price.TryGetInt64(out var ticks) || !TryText(suggestionJson, "why", TextMax, out var why))
            {
                return false;
            }

            if (Math.Abs(ticks) <= TickLimit)
            {
                suggestion = new FeedbackSuggestion(ticks, why);
            }
            else
            {
                dropped++;
            }
        }
        else if (suggestionJson.ValueKind != JsonValueKind.Null)
        {
            return false;
        }

        leg = new LegFeedback(name.GetString()!, index, likelihood.GetString()!, assessment, suggestion, cites);
        return true;
    }

    private static bool TryCites(JsonElement item, out IReadOnlyList<string> cites, ref int dropped)
    {
        cites = [];
        if (!item.TryGetProperty("cites", out var array) || array.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var kept = new List<string>();
        foreach (var cite in array.EnumerateArray())
        {
            var name = cite.ValueKind == JsonValueKind.String ? cite.GetString() : null;
            if (PlanMetricNames.IsKnown(name) && !kept.Contains(name!, StringComparer.Ordinal))
            {
                kept.Add(name!);
            }
            else if (!PlanMetricNames.IsKnown(name))
            {
                dropped++;
            }
        }

        cites = kept;
        return true;
    }

    private static bool TryText(JsonElement item, string property, int max, out string text)
    {
        text = string.Empty;
        if (!item.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        text = value.GetString()!;
        return text.Length <= max;
    }
}
