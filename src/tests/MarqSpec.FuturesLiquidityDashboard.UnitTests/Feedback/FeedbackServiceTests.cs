using System.Diagnostics.Metrics;
using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// reference: REQUIREMENTS.md FR-74, FR-8 (a failed call degrades to metrics only), NFR-6, NFR-9
public sealed class FeedbackServiceTests : IDisposable
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 19, 12, 0, 0, TimeSpan.Zero));
    private readonly IFeedbackModel _model = A.Fake<IFeedbackModel>();
    private readonly ILogger<FeedbackService> _logger = A.Fake<ILogger<FeedbackService>>();
    private readonly ServiceProvider _meters = new ServiceCollection().AddMetrics().BuildServiceProvider();
    private readonly List<string> _lines = [];
    private FeedbackBudget? _budget;

    public FeedbackServiceTests()
    {
        A.CallTo(() => _model.Provider).Returns("claude");
        A.CallTo(() => _logger.IsEnabled(A<LogLevel>._)).Returns(true);
        // Formatted when logged: the generated state is not read after the call returns.
        A.CallTo(_logger).Where(c => c.Method.Name == nameof(ILogger.Log)).Invokes(c => _lines.Add(
            $"{((Delegate)c.Arguments[4]!).DynamicInvoke(c.Arguments[2], c.Arguments[3])} "
            + string.Join(' ', (c.Arguments[2] as IEnumerable<KeyValuePair<string, object?>>)?.Select(kv => $"{kv.Key}={kv.Value}") ?? [])));
    }

    public void Dispose() => _meters.Dispose();

    [Fact]
    public async Task RequestAsync_ShouldReturnGroundedFeedback_WhenTheModelAnswersWithAValidResponse()
    {
        Answers(FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput("vibes"), FeedbackTestData.Usage(1000, 500)));
        var metrics = FeedbackTestData.Metrics();

        var reply = Answered(await Service().RequestAsync("viewer", FeedbackTestData.LongLimit, metrics, CancellationToken.None));

        reply.Metrics.Should().BeSameAs(metrics);
        reply.Reason.Should().BeNull();
        reply.Provider.Should().Be("claude");
        reply.Model.Should().Be("claude-opus-5-5");
        reply.Feedback!.Legs.Should().HaveCount(3);
        reply.Feedback.Legs[0].Cites.Should().NotContain("vibes");
    }

    [Fact]
    public async Task RequestAsync_ShouldSendTheMetricsAsDataInTheUserMessage_WhenItAsks()
    {
        Answers(FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput()));

        await Service().RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        A.CallTo(() => _model.CompleteAsync(
                A<FeedbackModelRequest>.That.Matches(r => r.UserMessage.Contains("\"definitionsVersion\":1", StringComparison.Ordinal) && r.Plan == FeedbackTestData.LongLimit),
                A<CancellationToken>._))
            .MustHaveHappenedOnceExactly();
    }

    [Theory]
    [InlineData("refusal", FeedbackReasons.Refusal)]
    [InlineData("max_tokens", FeedbackReasons.Truncated)]
    [InlineData("pause_turn", FeedbackReasons.InvalidResponse)]
    public async Task RequestAsync_ShouldReturnTheMetricsWithAReason_WhenTheModelStopsWithoutAnAnswer(string stopReason, string reason)
    {
        Answers(FeedbackTestData.Reply(stopReason, stopReason == "refusal" ? null : FeedbackTestData.ValidOutput()));

        var reply = Answered(await Service().RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None));

        reply.Feedback.Should().BeNull();
        reply.Reason.Should().Be(reason);
        reply.Metrics.Instrument.Should().Be("MES");
    }

    [Fact]
    public async Task RequestAsync_ShouldReturnInvalidResponse_WhenTheOutputFailsTheSchema()
    {
        Answers(FeedbackTestData.Reply("end_turn", """{"summary":"no legs"}"""));

        var reply = Answered(await Service().RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None));

        (reply.Feedback, reply.Reason).Should().Be((null, FeedbackReasons.InvalidResponse));
    }

    [Theory]
    [InlineData(FeedbackFailure.RateLimited, FeedbackReasons.UpstreamRateLimited)]
    [InlineData(FeedbackFailure.ServerError, FeedbackReasons.UpstreamError)]
    [InlineData(FeedbackFailure.Connection, FeedbackReasons.ConnectionError)]
    [InlineData(FeedbackFailure.ApiError, FeedbackReasons.ApiError)]
    [InlineData(FeedbackFailure.Timeout, FeedbackReasons.Timeout)]
    public async Task RequestAsync_ShouldReturnTheMetricsWithAReason_WhenTheCallFails(FeedbackFailure failure, string reason)
    {
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._)).ThrowsAsync(new FeedbackModelException(failure));

        var reply = Answered(await Service().RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None));

        (reply.Feedback, reply.Reason).Should().Be((null, reason));
        reply.Metrics.Legs.Should().HaveCount(4);
    }

    [Fact]
    public async Task RequestAsync_ShouldReturnTimeout_WhenTheCallOutlastsTheDeadline()
    {
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._))
            .ReturnsLazily(async (FeedbackModelRequest _, CancellationToken ct) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput());
            });
        var service = Service(o => o.TimeoutSeconds = 30);

        var pending = service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);
        _time.Advance(TimeSpan.FromSeconds(29));
        pending.IsCompleted.Should().BeFalse();
        _time.Advance(TimeSpan.FromSeconds(1));

        (Answered(await pending).Reason).Should().Be(FeedbackReasons.Timeout);
    }

    [Fact]
    public async Task RequestAsync_ShouldPropagateCancellation_WhenTheCallerGoesAway()
    {
        using var caller = new CancellationTokenSource();
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._))
            .ReturnsLazily(async (FeedbackModelRequest _, CancellationToken ct) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return FeedbackTestData.Reply("end_turn", null);
            });

        var pending = Service().RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), caller.Token);
        await caller.CancelAsync();

        await pending.Invoking(p => p).Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task RequestAsync_ShouldCountTheSpendFromUsage_WhenTheModelAnswersOrRefuses()
    {
        var service = Service();
        Answers(FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput(), FeedbackTestData.Usage(input: 1_000_000)));
        await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);
        Answers(FeedbackTestData.Reply("refusal", null, FeedbackTestData.Usage(input: 500_000)));
        await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        service.Status().SpentUsd.Should().Be(6m);
    }

    [Fact]
    public async Task RequestAsync_ShouldRefuseOverBudgetAndMakeNoCall_WhenTheMonthsSpendReachesTheCap()
    {
        var service = Service(o => o.MonthlyBudgetUsd = 4m);
        Answers(FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput(), FeedbackTestData.Usage(input: 1_000_000)));
        await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);
        Fake.ClearRecordedCalls(_model);

        var outcome = await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        outcome.Should().BeOfType<FeedbackOutcome.OverBudget>().Which.Status.Should().Match<FeedbackStatus>(s =>
            !s.Available && s.Reason == FeedbackReasons.BudgetExhausted && s.SpentUsd == 4m && s.BudgetUsd == 4m);
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._)).MustNotHaveHappened();
    }

    [Fact]
    public async Task RequestAsync_ShouldNotCountTheMockToTheBudget_WhenTheProviderIsMock()
    {
        A.CallTo(() => _model.Provider).Returns("mock");
        Answers(FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput(), FeedbackTestData.Usage(input: 1_000_000)));
        var service = Service(o => { o.Provider = FeedbackProvider.Mock; o.MonthlyBudgetUsd = 0m; o.ApiKey = null; });

        var reply = Answered(await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None));

        reply.Provider.Should().Be("mock");
        reply.Model.Should().Be("mock");
        service.Status().Should().Match<FeedbackStatus>(s => s.Available && s.SpentUsd == 0m && s.Provider == "mock");
    }

    [Fact]
    public async Task RequestAsync_ShouldPersistNothing_WhenTheProviderIsMock()
    {
        var disk = new FakeBudgetFiles();
        A.CallTo(() => _model.Provider).Returns("mock");
        Answers(FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput(), FeedbackTestData.Usage(input: 1_000_000)));
        var service = Service(o => { o.Provider = FeedbackProvider.Mock; o.ApiKey = null; }, new FeedbackBudgetStore("/data/b.json", disk, _time, A.Fake<ILogger>()));

        Answered(await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None));

        disk.Operations.Should().NotContain(o => o.StartsWith("write", StringComparison.Ordinal));
    }

    [Fact]
    public async Task RequestAsync_ShouldBeUnavailable_WhenFeedbackIsDisabled()
    {
        var outcome = await Service(o => o.Enabled = false).RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        outcome.Should().BeOfType<FeedbackOutcome.Unavailable>().Which.Status.Reason.Should().Be(FeedbackReasons.Disabled);
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._)).MustNotHaveHappened();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task RequestAsync_ShouldBeUnavailable_WhenClaudeHasNoKey(string? key)
    {
        var outcome = await Service(o => o.ApiKey = key).RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        outcome.Should().BeOfType<FeedbackOutcome.Unavailable>().Which.Status.Reason.Should().Be(FeedbackReasons.NoKey);
    }

    [Fact]
    public async Task RequestAsync_ShouldRefuse_WhenTheViewerAlreadyHasARequestInFlight()
    {
        var release = new TaskCompletionSource<ModelReply>();
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._)).Returns(release.Task);
        var service = Service();

        var first = service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);
        var second = await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);
        release.SetResult(FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput()));
        await first;

        second.Should().BeOfType<FeedbackOutcome.Refused>().Which.Refusal.Reason.Should().Be(FeedbackReasons.RequestInFlight);
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._)).MustHaveHappenedOnceExactly();
    }

    [Fact]
    public async Task RequestAsync_ShouldReleaseTheViewer_WhenTheCallFails()
    {
        var service = Service();
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._)).ThrowsAsync(new FeedbackModelException(FeedbackFailure.ServerError));
        await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        var next = await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        next.Should().BeOfType<FeedbackOutcome.Answered>();
    }

    [Fact]
    public async Task RequestAsync_ShouldRefuseTheSeventh_WhenSixStartedWithinAMinute()
    {
        Answers(FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput()));
        var service = Service();
        for (var i = 0; i < 6; i++)
        {
            (await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None)).Should().BeOfType<FeedbackOutcome.Answered>();
        }

        var seventh = await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        seventh.Should().BeOfType<FeedbackOutcome.Refused>().Which.Refusal.Reason.Should().Be(FeedbackReasons.RateLimited);
    }

    [Fact]
    public void Status_ShouldReportTheSpendAgainstTheCap_WhenAvailable()
    {
        Service().Status().Should().Be(new FeedbackStatus(
            true, null, "claude", "claude-opus-5-5", 0m, 100m, "2026-11", new DateTimeOffset(2026, 12, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds()));
    }

    [Fact]
    public async Task RequestAsync_ShouldLogNoKeyNoPromptAndNoResponseText_WhenItCallsTheModel()
    {
        Answers(FeedbackTestData.Reply("end_turn", FeedbackTestData.ValidOutput(), FeedbackTestData.Usage(1200, 400, 2000, 900)));
        var service = Service();
        await service.RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._)).ThrowsAsync(new FeedbackModelException(FeedbackFailure.Connection, "HttpRequestException"));
        await service.RequestAsync("viewer-2", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        var lines = LoggedLines();
        lines.Should().HaveCount(2, "one line per model call");
        lines[0].Should().Contain("claude-opus-5-5").And.Contain("1200").And.Contain("400").And.Contain("end_turn").And.Contain("ok");
        lines[1].Should().Contain("connection-error").And.Contain("HttpRequestException").And.NotContain(nameof(FeedbackModelException));
        lines.Should().NotContain(l => l.Contains(FeedbackTestData.SyntheticKey, StringComparison.Ordinal)
            || l.Contains("Entry sits", StringComparison.Ordinal)
            || l.Contains("definitionsVersion", StringComparison.Ordinal)
            || l.Contains("viewer", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("AnthropicUnauthorizedException", 401, "401")]
    [InlineData("AnthropicBadRequestException", 400, "400")]
    [InlineData("AnthropicInvalidDataException", null, "AnthropicInvalidDataException")]
    [InlineData("InvalidOperationException", null, "InvalidOperationException")]
    public async Task RequestAsync_ShouldLogTheOriginalCauseOfAnApiError_SoEachFailureReadsDifferently(string cause, int? status, string expected)
    {
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._)).ThrowsAsync(new FeedbackModelException(FeedbackFailure.ApiError, cause, status));

        var reply = Answered(await Service().RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None));

        reply.Reason.Should().Be(FeedbackReasons.ApiError, "the caller sees one category");
        var line = LoggedLines().Should().ContainSingle().Subject;
        line.Should().Contain("api-error").And.Contain(cause).And.Contain(expected).And.NotContain(nameof(FeedbackModelException));
        if (status is { } code)
        {
            line.Should().Contain($"HTTP {code}");
        }
        else
        {
            line.Should().Contain("no HTTP status");
        }
    }

    [Fact]
    public async Task RequestAsync_ShouldLogTheCancellation_WhenTheDeadlinePasses()
    {
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._))
            .ReturnsLazily(async (FeedbackModelRequest _, CancellationToken ct) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return FeedbackTestData.Reply("end_turn", null);
            });
        var pending = Service(o => o.TimeoutSeconds = 5).RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);
        _time.Advance(TimeSpan.FromSeconds(5));
        await pending;

        LoggedLines().Should().ContainSingle().Which.Should().Contain("timeout").And.Contain("TaskCanceledException");
    }

    [Fact]
    public async Task RequestAsync_ShouldRecordBoundedOutcomeLabels_WhenItCallsTheModel()
    {
        var tags = new List<string>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, l) =>
        {
            if (instrument.Meter.Name == FeedbackMetrics.MeterName)
            {
                l.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((i, _, t, _) => tags.AddRange(t.ToArray().Select(kv => $"{i.Name}:{kv.Key}={kv.Value}")));
        listener.SetMeasurementEventCallback<double>((i, _, t, _) => tags.AddRange(t.ToArray().Select(kv => $"{i.Name}:{kv.Key}={kv.Value}")));
        listener.Start();
        Answers(FeedbackTestData.Reply("refusal", null, FeedbackTestData.Usage(10, 0)));

        await Service().RequestAsync("viewer", FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), CancellationToken.None);

        tags.Should().Contain("fld.feedback.requests:outcome=refusal").And.Contain("fld.feedback.requests:provider=claude");
        tags.Should().NotContain(t => t.Contains("viewer", StringComparison.Ordinal) || t.Contains(FeedbackTestData.SyntheticKey, StringComparison.Ordinal));
    }

    private void Answers(ModelReply reply) =>
        A.CallTo(() => _model.CompleteAsync(A<FeedbackModelRequest>._, A<CancellationToken>._)).Returns(reply);

    private static PlanFeedbackReply Answered(FeedbackOutcome outcome) =>
        outcome.Should().BeOfType<FeedbackOutcome.Answered>().Subject.Reply;

    private FeedbackService Service(Action<FeedbackOptions>? configure = null, FeedbackBudgetStore? store = null)
    {
        var options = new FeedbackOptions { Enabled = true, ApiKey = FeedbackTestData.SyntheticKey };
        configure?.Invoke(options);
        var wrapped = Options.Create(options);
        _budget = new FeedbackBudget(_time, wrapped, store);
        return new FeedbackService(
            wrapped,
            _model,
            _budget,
            new FeedbackGate(_time, wrapped),
            new FeedbackMetrics(_meters.GetRequiredService<IMeterFactory>(), _budget),
            _time,
            _logger);
    }

    private List<string> LoggedLines() => _lines;
}
