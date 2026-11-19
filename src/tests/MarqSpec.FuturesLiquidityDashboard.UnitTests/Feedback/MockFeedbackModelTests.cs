using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// reference: REQUIREMENTS.md FR-74 (Mock: deterministic, schema-valid, from the metrics only, no cost)
public sealed class MockFeedbackModelTests
{
    private static FeedbackModelRequest Request(bool stopJustInside = false) =>
        new(FeedbackTestData.LongLimit, FeedbackTestData.Metrics(stopJustInside), "ignored by the mock");

    [Fact]
    public async Task CompleteAsync_ShouldReturnTheSameText_WhenGivenTheSameMetrics()
    {
        var model = new MockFeedbackModel();

        var first = await model.CompleteAsync(Request(), CancellationToken.None);
        var second = await new MockFeedbackModel().CompleteAsync(Request(), CancellationToken.None);

        second.Text.Should().Be(first.Text);
        first.StopReason.Should().Be("end_turn");
    }

    [Fact]
    public async Task CompleteAsync_ShouldGiveSchemaValidFeedbackCitingOnlyKnownMetrics_ForEveryLeg()
    {
        var reply = await new MockFeedbackModel().CompleteAsync(Request(), CancellationToken.None);

        var feedback = FeedbackGrounding.Ground(reply.Text, FeedbackTestData.Metrics());

        feedback.Should().NotBeNull();
        feedback!.DroppedCites.Should().Be(0);
        feedback.Legs.Select(l => (l.Leg, l.Index)).Should().Equal(("entry", null), ("stop", null), ("target", 0), ("target", 1));
        feedback.Legs.SelectMany(l => l.Cites).Should().OnlyContain(c => PlanMetricNames.IsKnown(c));
    }

    [Fact]
    public async Task CompleteAsync_ShouldRateFillLikelihoodFromTheSixtyBarTradeThrough_WhenItIsKnown()
    {
        var reply = await new MockFeedbackModel().CompleteAsync(Request(), CancellationToken.None);

        var legs = FeedbackGrounding.Ground(reply.Text, FeedbackTestData.Metrics())!.Legs;

        legs.Select(l => l.FillLikelihood).Should().Equal("medium", "low", "high", "unknown");
    }

    [Fact]
    public async Task CompleteAsync_ShouldNameTheRiskAndSuggestAPriceBeyondTheLevel_WhenTheStopSitsJustInsideOne()
    {
        var reply = await new MockFeedbackModel().CompleteAsync(Request(stopJustInside: true), CancellationToken.None);

        var feedback = FeedbackGrounding.Ground(reply.Text, FeedbackTestData.Metrics(stopJustInside: true))!;

        feedback.Legs[1].Suggestion!.PriceTicks.Should().Be(990, "one tick beyond the 991 VAL, away from the entry");
        feedback.Risks.Should().Contain(r => r.Cites.Contains("stopPlacement"));
    }

    [Fact]
    public async Task CompleteAsync_ShouldReportNoUsage_WhenItAnswers()
    {
        (await new MockFeedbackModel().CompleteAsync(Request(), CancellationToken.None)).Usage.Should().BeEmpty();
    }
}
