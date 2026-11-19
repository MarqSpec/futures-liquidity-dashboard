using System.Net;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// The wrapper runs the real Anthropic SDK; only the HTTP it would send is faked (CONVENTIONS.md §8.1).
public sealed class ClaudeFeedbackModelTests : IDisposable
{
    private readonly HttpMessageHandler _handler = A.Fake<HttpMessageHandler>();
    private readonly List<(HttpRequestMessage Request, string Body)> _sent = [];
    private Func<HttpResponseMessage> _respond = () => FeedbackTestData.ClaudeMessage(FeedbackTestData.ValidOutput());

    public ClaudeFeedbackModelTests()
    {
        A.CallTo(_handler).Where(c => c.Method.Name == "SendAsync").WithReturnType<Task<HttpResponseMessage>>()
            .ReturnsLazily(async call =>
            {
                var request = (HttpRequestMessage)call.Arguments[0]!;
                var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync();
                _sent.Add((request, body));
                return _respond();
            });
    }

    public void Dispose() => _handler.Dispose();

    [Fact]
    public async Task CompleteAsync_ShouldSendTheModelEffortSchemaAndACachedStaticSystemPrompt_WhenItAsks()
    {
        await Model().CompleteAsync(Request(), CancellationToken.None);

        using var body = JsonDocument.Parse(_sent.Single().Body);
        var root = body.RootElement;
        root.GetProperty("model").GetString().Should().Be("claude-opus-5-5");
        root.GetProperty("max_tokens").GetInt32().Should().Be(8000);
        root.GetProperty("output_config").GetProperty("effort").GetString().Should().Be("medium");
        root.GetProperty("output_config").GetProperty("format").GetProperty("type").GetString().Should().Be("json_schema");
        root.GetProperty("output_config").GetProperty("format").GetProperty("schema").GetProperty("required").EnumerateArray()
            .Select(e => e.GetString()).Should().Equal("summary", "legs", "risks");
        var system = root.GetProperty("system")[0];
        system.GetProperty("text").GetString().Should().Be(FeedbackPrompt.System);
        system.GetProperty("cache_control").GetProperty("type").GetString().Should().Be("ephemeral");
        root.GetProperty("messages")[0].GetProperty("role").GetString().Should().Be("user");
        root.GetProperty("messages")[0].GetProperty("content").ToString().Should().Contain("plan_data");
        root.TryGetProperty("temperature", out _).Should().BeFalse("Opus 5.5 takes no sampling parameters");
    }

    [Fact]
    public async Task CompleteAsync_ShouldOptInToTheDefaultServerSideFallback_WhenServerFallbackIsOn()
    {
        await Model().CompleteAsync(Request(), CancellationToken.None);

        var (request, body) = _sent.Single();
        JsonDocument.Parse(body).RootElement.GetProperty("fallbacks").GetString().Should().Be("default");
        request.Headers.GetValues("anthropic-beta").Should().Contain(v => v.Contains("server-side-fallback-2026-07-01", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CompleteAsync_ShouldSendNoFallback_WhenServerFallbackIsOff()
    {
        await Model(o => o.ServerFallback = false).CompleteAsync(Request(), CancellationToken.None);

        var (request, body) = _sent.Single();
        JsonDocument.Parse(body).RootElement.TryGetProperty("fallbacks", out _).Should().BeFalse();
        request.Headers.Contains("anthropic-beta").Should().BeFalse();
    }

    [Fact]
    public async Task CompleteAsync_ShouldAuthenticateWithTheConfiguredKey_OverHttps()
    {
        await Model().CompleteAsync(Request(), CancellationToken.None);

        var request = _sent.Single().Request;
        request.RequestUri!.Scheme.Should().Be("https");
        request.RequestUri.AbsolutePath.Should().Be("/v1/messages");
        // Anthropic SDK 13.10 sends ApiKey as a bearer token (its ClientOptions.ApiKey documentation).
        (request.Headers.Authorization?.Scheme, request.Headers.Authorization?.Parameter).Should().Be(("Bearer", FeedbackTestData.SyntheticKey));
    }

    [Fact]
    public async Task CompleteAsync_ShouldReturnTheTextStopReasonAndUsage_WhenTheApiAnswers()
    {
        var reply = await Model().CompleteAsync(Request(), CancellationToken.None);

        reply.StopReason.Should().Be("end_turn");
        reply.Text.Should().Be(FeedbackTestData.ValidOutput());
        reply.Usage.Should().Equal(new TokenUsage("claude-opus-5-5", 1200, 400, 2000, 900));
    }

    [Fact]
    public async Task CompleteAsync_ShouldReturnARefusalWithNoText_WhenTheModelDeclines()
    {
        _respond = () => FeedbackTestData.ClaudeMessage(string.Empty, "refusal");

        var reply = await Model().CompleteAsync(Request(), CancellationToken.None);

        (reply.StopReason, reply.Text).Should().Be(("refusal", null));
        reply.Usage.Should().ContainSingle();
    }

    [Fact]
    public async Task CompleteAsync_ShouldCountEveryAttempt_WhenAFallbackModelRan()
    {
        _respond = () => FeedbackTestData.ClaudeMessage(FeedbackTestData.ValidOutput(), extraUsage: """
            ,"iterations":[
              {"type":"message","model":"claude-opus-5-5","input_tokens":1200,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},
              {"type":"fallback_message","model":"claude-opus-4-8","input_tokens":1200,"output_tokens":400,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}]
            """);

        var reply = await Model().CompleteAsync(Request(), CancellationToken.None);

        reply.Usage.Should().Equal(new TokenUsage("claude-opus-5-5", 1200, 0, 0, 0), new TokenUsage("claude-opus-4-8", 1200, 400, 0, 0));
    }

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests, "rate_limit_error", FeedbackFailure.RateLimited)]
    [InlineData(HttpStatusCode.InternalServerError, "api_error", FeedbackFailure.ServerError)]
    [InlineData((HttpStatusCode)529, "overloaded_error", FeedbackFailure.ServerError)]
    [InlineData(HttpStatusCode.Unauthorized, "authentication_error", FeedbackFailure.ApiError)]
    [InlineData(HttpStatusCode.BadRequest, "invalid_request_error", FeedbackFailure.ApiError)]
    public async Task CompleteAsync_ShouldThrowTheTypedFailureWithoutTheKey_WhenTheApiAnswersAnError(HttpStatusCode status, string type, FeedbackFailure failure)
    {
        _respond = () => FeedbackTestData.ClaudeError(status, type);

        var act = () => Model().CompleteAsync(Request(), CancellationToken.None);

        var thrown = (await act.Should().ThrowAsync<FeedbackModelException>()).Which;
        thrown.Failure.Should().Be(failure);
        thrown.InnerException.Should().BeNull();
        thrown.ToString().Should().NotContain(FeedbackTestData.SyntheticKey);
        // Safe to log: the HTTP status and the SDK's exception type, never its message or body.
        thrown.StatusCode.Should().Be((int)status);
        thrown.Cause.Should().StartWith("Anthropic").And.EndWith("Exception").And.NotContain(FeedbackTestData.SyntheticKey);
    }

    [Fact]
    public async Task CompleteAsync_ShouldThrowConnection_WhenTheNetworkFails()
    {
        _respond = () => throw new HttpRequestException($"socket closed for {FeedbackTestData.SyntheticKey}");

        var act = () => Model().CompleteAsync(Request(), CancellationToken.None);

        var thrown = (await act.Should().ThrowAsync<FeedbackModelException>()).Which;
        thrown.Failure.Should().Be(FeedbackFailure.Connection);
        thrown.ToString().Should().NotContain(FeedbackTestData.SyntheticKey);
        (thrown.Cause, thrown.StatusCode).Should().Be(("AnthropicIOException", null), "the SDK wraps a transport failure in its own type");
    }

    [Fact]
    public async Task CompleteAsync_ShouldThrowApiErrorWithoutTheKey_WhenSomethingUnexpectedFails()
    {
        _respond = () => throw new InvalidOperationException($"unexpected while sending {FeedbackTestData.SyntheticKey}");

        var act = () => Model().CompleteAsync(Request(), CancellationToken.None);

        var thrown = (await act.Should().ThrowAsync<FeedbackModelException>()).Which;
        thrown.Failure.Should().Be(FeedbackFailure.ApiError);
        thrown.InnerException.Should().BeNull();
        thrown.ToString().Should().NotContain(FeedbackTestData.SyntheticKey);
        (thrown.Cause, thrown.StatusCode).Should().Be(("InvalidOperationException", null), "our own bug reads differently from the API's");
    }

    [Fact]
    public async Task CompleteAsync_ShouldThrowApiError_WhenTheReplyCannotBeRead()
    {
        // A 200 with no usage: the SDK only finds out when the field is read.
        _respond = () => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"id":"msg_synthetic","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":"end_turn","stop_sequence":null}""",
                System.Text.Encoding.UTF8,
                "application/json"),
        };

        var act = () => Model().CompleteAsync(Request(), CancellationToken.None);

        var thrown = (await act.Should().ThrowAsync<FeedbackModelException>()).Which;
        (thrown.Failure, thrown.Cause, thrown.StatusCode).Should().Be((FeedbackFailure.ApiError, "AnthropicInvalidDataException", null));
    }

    [Fact]
    public async Task CompleteAsync_ShouldPropagateCancellation_WhenTheCallerCancelsDuringTheCall()
    {
        using var caller = new CancellationTokenSource();
        var started = new TaskCompletionSource();
        A.CallTo(_handler).Where(c => c.Method.Name == "SendAsync").WithReturnType<Task<HttpResponseMessage>>()
            .ReturnsLazily(async call =>
            {
                started.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, (CancellationToken)call.Arguments[1]!);
                return FeedbackTestData.ClaudeMessage(FeedbackTestData.ValidOutput());
            });

        var pending = Model().CompleteAsync(Request(), caller.Token);
        await started.Task;
        await caller.CancelAsync();

        await pending.Invoking(p => p).Should().ThrowAsync<OperationCanceledException>("a caller who left is not an API error");
    }

    [Fact]
    public async Task CompleteAsync_ShouldPropagateCancellation_WhenTheCallerCancels()
    {
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();

        var act = () => Model().CompleteAsync(Request(), cancelled.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    private ClaudeFeedbackModel Model(Action<FeedbackOptions>? configure = null)
    {
        var options = new FeedbackOptions { Enabled = true, ApiKey = FeedbackTestData.SyntheticKey, MaxRetries = 0 };
        configure?.Invoke(options);
        var factory = A.Fake<IHttpClientFactory>();
        A.CallTo(() => factory.CreateClient(ClaudeFeedbackModel.HttpClientName)).ReturnsLazily(() => new HttpClient(_handler, disposeHandler: false));
        return new ClaudeFeedbackModel(factory, Options.Create(options));
    }

    private static FeedbackModelRequest Request() =>
        new(FeedbackTestData.LongLimit, FeedbackTestData.Metrics(), FeedbackPrompt.UserMessage(FeedbackTestData.LongLimit, FeedbackTestData.Metrics()));
}
