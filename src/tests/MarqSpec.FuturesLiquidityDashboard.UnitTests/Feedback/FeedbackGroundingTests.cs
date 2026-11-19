using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// reference: REQUIREMENTS.md FR-74 (every claim cites a metric; a cite naming no metric is dropped)
public sealed class FeedbackGroundingTests
{
    private static readonly string[] News = ["news"];
    private static readonly string[] CoverageOnly = ["coverage"];

    [Fact]
    public void Ground_ShouldKeepEveryCitedClaimInLegOrder_WhenTheOutputIsValid()
    {
        var feedback = FeedbackGrounding.Ground(FeedbackTestData.ValidOutput(), FeedbackTestData.Metrics());

        feedback.Should().NotBeNull();
        feedback!.Summary.Should().StartWith("Entry sits");
        feedback.Legs.Select(l => (l.Leg, l.Index, l.FillLikelihood)).Should().Equal(("entry", null, "medium"), ("stop", null, "low"), ("target", 0, "high"));
        feedback.Legs[1].Suggestion.Should().Be(new FeedbackSuggestion(990, "Below the 991 VAL."));
        feedback.Risks.Should().ContainSingle().Which.Cites.Should().Equal("throughFrequency.60");
        feedback.DefinitionsVersion.Should().Be(1);
    }

    [Fact]
    public void Ground_ShouldDropACiteThatNamesNoMetric_WhenTheOutputCitesAnUnknownName()
    {
        var feedback = FeedbackGrounding.Ground(FeedbackTestData.ValidOutput("vibes"), FeedbackTestData.Metrics());

        feedback!.Legs[0].Cites.Should().Equal("throughFrequency.60");
        feedback.DroppedCites.Should().Be(1);
    }

    [Fact]
    public void Ground_ShouldDropACite_WhenItDiffersFromAMetricNameOnlyInCase()
    {
        var feedback = FeedbackGrounding.Ground(FeedbackTestData.ValidOutput("ThroughFrequency.240"), FeedbackTestData.Metrics());

        feedback!.Legs[0].Cites.Should().Equal("throughFrequency.60");
        feedback.DroppedCites.Should().Be(1);
    }

    [Fact]
    public void Ground_ShouldDropALegClaim_WhenNoneOfItsCitesNamesAMetric()
    {
        var json = Output(legs: [Leg("entry", null, ["vibes", "gut"]), Leg("stop", null, ["stopAtr"])]);

        var feedback = FeedbackGrounding.Ground(json, FeedbackTestData.Metrics());

        feedback!.Legs.Should().ContainSingle().Which.Leg.Should().Be("stop");
        feedback.DroppedCites.Should().Be(3, "two cites and the claim that was left with none");
    }

    [Fact]
    public void Ground_ShouldDropARisk_WhenItCitesNoMetric()
    {
        var json = Output(risks: [new { text = "Unfounded.", cites = News }, new { text = "Grounded.", cites = CoverageOnly }]);

        var feedback = FeedbackGrounding.Ground(json, FeedbackTestData.Metrics());

        feedback!.Risks.Select(r => r.Text).Should().Equal("Grounded.");
        feedback.DroppedCites.Should().Be(2, "the cite that named no metric, and the risk it left uncited");
    }

    [Fact]
    public void Ground_ShouldDropALeg_WhenItMatchesNoLegOfThePlanOrRepeatsOne()
    {
        var json = Output(legs: [Leg("target", 5, ["rewardRisk"]), Leg("entry", 0, ["distanceAtr"]), Leg("stop", null, ["stopAtr"]), Leg("stop", null, ["stopAtr"])]);

        var feedback = FeedbackGrounding.Ground(json, FeedbackTestData.Metrics());

        feedback!.Legs.Should().ContainSingle().Which.Leg.Should().Be("stop");
        feedback.DroppedCites.Should().Be(3, "an unknown target, an entry with an index and a repeated stop are each a dropped claim");
    }

    [Fact]
    public void Ground_ShouldTakeAsOfFromTheMetrics_WhenTheOutputIsValid()
    {
        FeedbackGrounding.Ground(FeedbackTestData.ValidOutput(), FeedbackTestData.Metrics())!.AsOfMs.Should().Be(FeedbackTestData.AsOfMs);
    }

    [Fact]
    public void Ground_ShouldDropTheSuggestion_WhenItsPriceIsBeyondTheTickRange()
    {
        var json = Output(legs: [Leg("stop", null, ["stopAtr"], new { priceTicks = 2_000_000_000L, why = "Far." })]);

        var feedback = FeedbackGrounding.Ground(json, FeedbackTestData.Metrics());

        feedback!.Legs.Should().ContainSingle().Which.Suggestion.Should().BeNull();
        feedback.DroppedCites.Should().Be(1, "the dropped suggestion is a dropped claim; the leg and its cite stay");
    }

    [Fact]
    public void Ground_ShouldNotCountTheSuggestion_WhenItsPriceIsAtTheTickLimit()
    {
        var json = Output(legs: [Leg("stop", null, ["stopAtr"], new { priceTicks = -1_000_000_000L, why = "At the limit." })]);

        var feedback = FeedbackGrounding.Ground(json, FeedbackTestData.Metrics());

        feedback!.Legs.Should().ContainSingle().Which.Suggestion!.PriceTicks.Should().Be(-1_000_000_000);
        feedback.DroppedCites.Should().Be(0);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("""{"legs":[],"risks":[]}""")]
    [InlineData("""{"summary":"s","risks":[]}""")]
    [InlineData("""{"summary":"s","legs":[],"risks":"none"}""")]
    [InlineData("""{"summary":"s","legs":[{"leg":"entry","index":null,"fillLikelihood":"certain","assessment":"a","suggestion":null,"cites":["stopAtr"]}],"risks":[]}""")]
    [InlineData("""{"summary":"s","legs":[{"leg":"middle","index":null,"fillLikelihood":"low","assessment":"a","suggestion":null,"cites":["stopAtr"]}],"risks":[]}""")]
    [InlineData("""{"summary":"s","legs":[{"leg":"entry","index":null,"fillLikelihood":"low","suggestion":null,"cites":["stopAtr"]}],"risks":[]}""")]
    [InlineData("""{"summary":"s","legs":[{"leg":"entry","index":null,"fillLikelihood":"low","assessment":"a","suggestion":null,"cites":"stopAtr"}],"risks":[]}""")]
    public void Ground_ShouldReturnNull_WhenTheOutputFailsTheSchema(string? json)
    {
        FeedbackGrounding.Ground(json, FeedbackTestData.Metrics()).Should().BeNull();
    }

    [Fact]
    public void Ground_ShouldReturnNull_WhenATextFieldIsOverItsCap()
    {
        var json = Output(summary: new string('x', 2001));

        FeedbackGrounding.Ground(json, FeedbackTestData.Metrics()).Should().BeNull();
    }

    private static object Leg(string leg, int? index, string[] cites, object? suggestion = null) =>
        new { leg, index, fillLikelihood = "low", assessment = "a", suggestion, cites };

    private static string Output(object[]? legs = null, object[]? risks = null, string summary = "s") =>
        JsonSerializer.Serialize(new { summary, legs = legs ?? [], risks = risks ?? [] });
}
