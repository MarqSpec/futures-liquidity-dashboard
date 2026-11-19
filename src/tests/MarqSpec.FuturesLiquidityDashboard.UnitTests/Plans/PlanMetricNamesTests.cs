using System.Reflection;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Plans;

// reference: REQUIREMENTS.md FR-73, FR-74 (a cite names a metric of PlanMetrics, definitions version 1)
public sealed class PlanMetricNamesTests
{
    // Not metrics: they say which leg, or why a value is unknown.
    private static readonly string[] LegIdentity = ["Leg", "Index", "PriceTicks", "DistanceReason", "KeyLevelsReason"];
    private static readonly string[] PlanIdentity = ["DefinitionsVersion", "Instrument", "ContractId", "AsOfMs", "StopAtrReason"];

    [Fact]
    public void Leg_ShouldNameOnlyFieldsOfLegMetrics_SoARenamedFieldFailsHere()
    {
        PlanMetricNames.Leg.Should().OnlyContain(name => Resolves(typeof(LegMetrics), name), "each name is a camelCase path into LegMetrics");
    }

    [Fact]
    public void Plan_ShouldNameOnlyFieldsOfPlanMetrics_SoARenamedFieldFailsHere()
    {
        PlanMetricNames.Plan.Should().OnlyContain(name => Resolves(typeof(PlanMetrics), name), "each name is a camelCase field of PlanMetrics");
    }

    [Fact]
    public void All_ShouldCoverEveryMetricField_SoANewFieldIsCiteable()
    {
        var legFields = Properties(typeof(LegMetrics)).Select(p => p.Name).Except(LegIdentity);
        var planFields = Properties(typeof(PlanMetrics)).Select(p => p.Name).Except(PlanIdentity).Except(["Legs"]);

        legFields.Should().OnlyContain(field => PlanMetricNames.Leg.Any(n => Head(n) == field), "every leg metric has a citeable name");
        planFields.Should().OnlyContain(field => PlanMetricNames.Plan.Any(n => Head(n) == field), "every plan metric has a citeable name");
    }

    [Theory]
    [InlineData("distanceticks")]
    [InlineData("restingAhead.later")]
    [InlineData("throughFrequency.61")]
    [InlineData("flow")]
    public void Resolves_ShouldRefuse_WhenANameIsNotAFieldPath(string name)
    {
        Resolves(typeof(LegMetrics), name).Should().BeFalse("the check that guards the names must be able to fail");
    }

    // A name is camelCase segments; a numeric segment after throughFrequency is its window's bar count (60 or 240).
    private static bool Resolves(Type root, string name)
    {
        var segments = name.Split('.');
        var type = root;
        for (var i = 0; i < segments.Length; i++)
        {
            var segment = segments[i];
            if (int.TryParse(segment, out var bars))
            {
                return i == segments.Length - 1 && i > 0 && segments[i - 1] == "throughFrequency" && bars is 60 or 240;
            }

            var property = Properties(type).SingleOrDefault(p => p.Name == char.ToUpperInvariant(segment[0]) + segment[1..] && segment[0] == char.ToLowerInvariant(segment[0]));
            if (property is null)
            {
                return false;
            }

            type = Element(property.PropertyType);
            // A path must end at a value; `flow` alone names a group, not a metric.
            if (i == segments.Length - 1 && type == typeof(FlowContext))
            {
                return false;
            }
        }

        return true;
    }

    private static Type Element(Type type)
    {
        var underlying = Nullable.GetUnderlyingType(type) ?? type;
        var list = underlying.IsGenericType && underlying.GetGenericTypeDefinition() == typeof(IReadOnlyList<>) ? underlying.GetGenericArguments()[0] : null;
        return list ?? underlying;
    }

    private static PropertyInfo[] Properties(Type type) => type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
        .Where(p => p.Name != "EqualityContract")
        .ToArray();

    private static string Head(string name)
    {
        var head = name.Split('.')[0];
        return char.ToUpperInvariant(head[0]) + head[1..];
    }
}
