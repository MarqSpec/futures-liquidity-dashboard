using System.Diagnostics.Metrics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// reference: REQUIREMENTS.md FR-74, FR-6, NFR-6; INTERFACES.md D.1
public sealed class FeedbackEndpointTests : IDisposable
{
    private static readonly Uri Status = new("/api/plans/feedback/status", UriKind.Relative);
    private static readonly Uri Feedback = new("/api/plans/feedback/MES", UriKind.Relative);
    private static readonly string[] OrderWords = ["order", "trade", "execute", "position", "account", "cancel", "flatten"];

    private readonly HttpMessageHandler _upstream = A.Fake<HttpMessageHandler>();
    private readonly List<HttpRequestMessage> _sent = [];
    private readonly List<FeedbackHostFactory> _hosts = [];
    private Func<Task<HttpResponseMessage>> _respond = () => Task.FromResult(FeedbackTestData.ClaudeMessage(FeedbackTestData.ValidOutput("vibes")));

    public FeedbackEndpointTests()
    {
        A.CallTo(_upstream).Where(c => c.Method.Name == "SendAsync").WithReturnType<Task<HttpResponseMessage>>()
            .ReturnsLazily(call =>
            {
                _sent.Add((HttpRequestMessage)call.Arguments[0]!);
                return _respond();
            });
    }

    public void Dispose()
    {
        foreach (var host in _hosts)
        {
            host.Dispose();
        }

        _upstream.Dispose();
    }

    [Fact]
    public async Task Status_ShouldBeUnauthorized_WhenNoKeyIsSentOutsideDevelopment()
    {
        using var client = Host().Client(null);

        (await client.GetAsync(Status)).StatusCode.Should().Be(HttpStatusCode.Unauthorized, "production grants nothing anonymously");
    }

    [Fact]
    public async Task Status_ShouldBeForbidden_WhenTheCallerLacksRequestFeedback()
    {
        using var client = Host().Client(FeedbackHostFactory.PlainViewerKey);

        (await client.GetAsync(Status)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Status_ShouldReportAvailabilityAndSpendWithoutTheKey_WhenTheCallerHoldsRequestFeedback()
    {
        using var client = Host().Client(FeedbackHostFactory.FeedbackOnlyKey);

        using var response = await client.GetAsync(Status);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().NotContain(FeedbackTestData.SyntheticKey);
        using var doc = JsonDocument.Parse(body);
        doc.RootElement.GetProperty("available").GetBoolean().Should().BeTrue();
        doc.RootElement.GetProperty("provider").GetString().Should().Be("claude");
        doc.RootElement.GetProperty("budgetUsd").GetDecimal().Should().Be(100m);
        doc.RootElement.GetProperty("spentUsd").GetDecimal().Should().Be(0m);
    }

    [Fact]
    public async Task Feedback_ShouldBeForbidden_WhenTheCallerLacksRequestFeedback()
    {
        var host = Host();
        using var client = host.Client(FeedbackHostFactory.PlainViewerKey);

        using var response = await client.PostAsJsonAsync(Feedback, await Plan(client));

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        _sent.Should().BeEmpty();
    }

    [Fact]
    public async Task RequestFeedback_ShouldGrantNoOtherAction_WhenItIsTheCallersOnlyGrant()
    {
        var host = Host();
        using var viewer = host.Client(FeedbackHostFactory.FeedbackViewerKey);
        var plan = await Plan(viewer);
        using var client = host.Client(FeedbackHostFactory.FeedbackOnlyKey);

        (await client.PostAsJsonAsync(Feedback, plan)).StatusCode.Should().Be(HttpStatusCode.Forbidden, "the reply carries market metrics, which need view-dashboard");
        (await client.PostAsJsonAsync(new Uri("/api/plans/metrics/MES", UriKind.Relative), plan)).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await client.GetAsync(new Uri("/api/snapshot/MES", UriKind.Relative))).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await client.GetAsync(new Uri("/api/context/MES", UriKind.Relative))).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await client.GetAsync(new Uri("/api/layouts/me", UriKind.Relative))).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await client.GetAsync(Status)).StatusCode.Should().Be(HttpStatusCode.OK);
        _sent.Should().BeEmpty();
    }

    [Fact]
    public async Task Feedback_ShouldReturnGroundedClaudeFeedbackBesideTheMetrics_WhenTheApiAnswers()
    {
        using var client = Host().Client(FeedbackHostFactory.FeedbackViewerKey);

        using var response = await client.PostAsJsonAsync(Feedback, await Plan(client));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        root.GetProperty("provider").GetString().Should().Be("claude");
        root.GetProperty("reason").ValueKind.Should().Be(JsonValueKind.Null);
        root.GetProperty("metrics").GetProperty("definitionsVersion").GetInt32().Should().Be(1);
        var legs = root.GetProperty("feedback").GetProperty("legs");
        legs.EnumerateArray().Select(l => l.GetProperty("leg").GetString()).Should().Equal("entry", "stop", "target");
        legs.EnumerateArray().SelectMany(l => l.GetProperty("cites").EnumerateArray().Select(c => c.GetString()))
            .Should().OnlyContain(c => PlanMetricNames.IsKnown(c)).And.NotContain("vibes");
        root.GetProperty("feedback").GetProperty("droppedCites").GetInt32().Should().Be(1);
        _sent.Should().ContainSingle();
    }

    [Fact]
    public async Task Feedback_ShouldReturnTheMetricsWithAReason_WhenTheApiAnswers500()
    {
        _respond = () => Task.FromResult(FeedbackTestData.ClaudeError(HttpStatusCode.InternalServerError, "api_error"));
        using var client = Host().Client(FeedbackHostFactory.FeedbackViewerKey);

        using var response = await client.PostAsJsonAsync(Feedback, await Plan(client));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        doc.RootElement.GetProperty("feedback").ValueKind.Should().Be(JsonValueKind.Null);
        doc.RootElement.GetProperty("reason").GetString().Should().Be(FeedbackReasons.UpstreamError);
        doc.RootElement.GetProperty("metrics").GetProperty("legs").GetArrayLength().Should().Be(3, "the entry, the stop and one target");
    }

    [Fact]
    public async Task Feedback_ShouldKeepTheKeyOutOfEveryLogLineResponseAndMetricLabel_WhenCallsSucceedAndFail()
    {
        var logs = new List<string>();
        var labels = new List<string>();
        using var listener = Labels(labels);
        var host = Host();
        host.ExtraServices.Add(s => s.AddLogging(l => l.SetMinimumLevel(LogLevel.Trace).AddProvider(new CollectingProvider(logs))));
        using var client = host.Client(FeedbackHostFactory.FeedbackViewerKey);
        var bodies = new List<string>();
        var plan = await Plan(client);

        foreach (var respond in new Func<HttpResponseMessage>[]
        {
            () => FeedbackTestData.ClaudeMessage(FeedbackTestData.ValidOutput()),
            () => FeedbackTestData.ClaudeError(HttpStatusCode.Unauthorized, "authentication_error"),
            () => throw new HttpRequestException($"reset while sending {FeedbackTestData.SyntheticKey}"),
            () => throw new InvalidOperationException($"our own bug near {FeedbackTestData.SyntheticKey}"),
        })
        {
            _respond = () => Task.FromResult(respond());
            using var response = await client.PostAsJsonAsync(Feedback, plan);
            bodies.Add(await response.Content.ReadAsStringAsync());
        }

        bodies.Add(await client.GetStringAsync(Status));

        // Each failure logs its own cause.
        var failures = logs.Where(l => l.Contains("Feedback call claude claude-opus-5-5 failed", StringComparison.Ordinal)).ToList();
        failures.Should().HaveCount(3);
        failures.Should().ContainSingle(l => l.Contains("api-error", StringComparison.Ordinal) && l.Contains("HTTP 401", StringComparison.Ordinal));
        failures.Should().ContainSingle(l => l.Contains("connection-error", StringComparison.Ordinal) && l.Contains("AnthropicIOException", StringComparison.Ordinal));
        failures.Should().ContainSingle(l => l.Contains("api-error", StringComparison.Ordinal) && l.Contains("InvalidOperationException", StringComparison.Ordinal));
        failures.Should().NotContain(l => l.Contains(nameof(FeedbackModelException), StringComparison.Ordinal));
        _sent.Should().HaveCount(4).And.OnlyContain(r => r.Headers.Authorization!.Parameter == FeedbackTestData.SyntheticKey, "the key was really sent upstream");
        logs.Should().Contain(l => l.Contains("claude-opus-5-5", StringComparison.Ordinal), "the model calls were logged");
        labels.Should().Contain(l => l.StartsWith("fld.feedback.requests:", StringComparison.Ordinal), "the outcomes were counted");
        logs.Should().NotContain(l => l.Contains(FeedbackTestData.SyntheticKey, StringComparison.Ordinal));
        bodies.Should().NotContain(b => b.Contains(FeedbackTestData.SyntheticKey, StringComparison.Ordinal));
        labels.Should().NotContain(l => l.Contains(FeedbackTestData.SyntheticKey, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Feedback_ShouldAnswer503WithAReasonAndStartupShouldSucceed_WhenFeedbackIsDisabled()
    {
        var host = Host(new() { ["Feedback:Enabled"] = "false" });
        using var client = host.Client(FeedbackHostFactory.FeedbackViewerKey);

        using var response = await client.PostAsJsonAsync(Feedback, await Plan(client));

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await response.Content.ReadAsStringAsync()).Should().Contain("\"reason\":\"disabled\"");
        (await client.GetStringAsync(Status)).Should().Contain("\"available\":false");
        _sent.Should().BeEmpty();
    }

    [Fact]
    public async Task Feedback_ShouldAnswer503NoKey_WhenClaudeHasNoKey()
    {
        var host = Host(new() { ["Feedback:ApiKey"] = string.Empty });
        using var client = host.Client(FeedbackHostFactory.FeedbackViewerKey);

        using var response = await client.PostAsJsonAsync(Feedback, await Plan(client));

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await response.Content.ReadAsStringAsync()).Should().Contain("\"reason\":\"no-key\"");
    }

    [Fact]
    public async Task Feedback_ShouldAnswer429AndMakeNoCall_WhenTheBudgetIsSpent()
    {
        var host = Host(new() { ["Feedback:MonthlyBudgetUsd"] = "0" });
        using var client = host.Client(FeedbackHostFactory.FeedbackViewerKey);

        using var response = await client.PostAsJsonAsync(Feedback, await Plan(client));

        response.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        (await response.Content.ReadAsStringAsync()).Should().Contain("\"reason\":\"budget-exhausted\"").And.Contain("\"budgetUsd\":0");
        _sent.Should().BeEmpty();
    }

    [Fact]
    public async Task Feedback_ShouldAnswer429_OnTheSeventhRequestInAMinute()
    {
        using var client = Host().Client(FeedbackHostFactory.FeedbackViewerKey);
        var plan = await Plan(client);
        for (var i = 0; i < 6; i++)
        {
            (await client.PostAsJsonAsync(Feedback, plan)).StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var seventh = await client.PostAsJsonAsync(Feedback, plan);

        seventh.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        (await seventh.Content.ReadAsStringAsync()).Should().Contain("\"reason\":\"rate-limited\"");
        seventh.Headers.RetryAfter.Should().NotBeNull();
        _sent.Should().HaveCount(6);
    }

    // A mutant that lets the second request through must fail here, not stall the run (review round 2). The xUnit
    // timeout is the effective bound: cancelling an in-memory test-server request does not end it while the upstream
    // is held, so the inner bounds below only keep the happy path's waits finite.
    [Fact(Timeout = 30_000)]
    public async Task Feedback_ShouldAnswer429_WhenTheViewerAlreadyHasARequestInFlight()
    {
        // Not the effective bound (see above): it ends the waits this test controls, not a request the server holds.
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _respond = async () =>
        {
            await release.Task;
            return FeedbackTestData.ClaudeMessage(FeedbackTestData.ValidOutput());
        };
        using var client = Host().Client(FeedbackHostFactory.FeedbackViewerKey);
        var plan = await Plan(client);

        var first = client.PostAsJsonAsync(Feedback, plan, bound.Token);
        while (_sent.Count == 0)
        {
            await Task.Delay(10, bound.Token);
        }

        HttpResponseMessage? second = null;
        try
        {
            using var secondBound = CancellationTokenSource.CreateLinkedTokenSource(bound.Token);
            secondBound.CancelAfter(TimeSpan.FromSeconds(5));
            second = await client.PostAsJsonAsync(Feedback, plan, secondBound.Token);
        }
        catch (OperationCanceledException)
        {
            // Asserted below: no answer within the bound.
        }
        finally
        {
            release.TrySetResult();
        }

        using var firstResponse = await first.WaitAsync(bound.Token);
        using var secondResponse = second;

        secondResponse.Should().NotBeNull("a second request in flight is refused at once, not queued behind the first");
        secondResponse!.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        (await secondResponse.Content.ReadAsStringAsync(bound.Token)).Should().Contain("\"reason\":\"request-in-flight\"");
        firstResponse.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Feedback_ShouldRefuseWithA400NamingTheField_WhenTheStopIsOnTheWrongSide()
    {
        using var client = Host().Client(FeedbackHostFactory.FeedbackViewerKey);

        using var response = await client.PostAsJsonAsync(Feedback, await Plan(client, stopTicks: 20_001));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync()).Should().Contain("Position.StopTicks");
        _sent.Should().BeEmpty();
    }

    [Fact]
    public async Task Feedback_ShouldReturnTheMetricsWithApiError_WhenSomethingUnexpectedFails()
    {
        _respond = () => throw new InvalidOperationException("unexpected");
        using var client = Host().Client(FeedbackHostFactory.FeedbackViewerKey);

        using var response = await client.PostAsJsonAsync(Feedback, await Plan(client));

        response.StatusCode.Should().Be(HttpStatusCode.OK, "an unexpected failure degrades, it is not a 500");
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        doc.RootElement.GetProperty("feedback").ValueKind.Should().Be(JsonValueKind.Null);
        doc.RootElement.GetProperty("reason").GetString().Should().Be(FeedbackReasons.ApiError);
    }

    [Fact]
    public async Task Metrics_ShouldExportTheFeedbackSeriesUnderTheNamesObservabilityDocuments()
    {
        using var client = Host().Client(FeedbackHostFactory.FeedbackViewerKey);
        (await client.PostAsJsonAsync(Feedback, await Plan(client))).StatusCode.Should().Be(HttpStatusCode.OK);

        var names = (await client.GetStringAsync(new Uri("/metrics", UriKind.Relative))).Split('\n')
            .Where(l => l.StartsWith("fld_feedback", StringComparison.Ordinal))
            .Select(l => l.Split('{', ' ')[0])
            .ToHashSet(StringComparer.Ordinal);

        // OBSERVABILITY.md §2, exactly: the exporter adds a unit suffix, so a unit must not change these.
        names.Should().BeEquivalentTo(
            "fld_feedback_requests_total",
            "fld_feedback_duration_milliseconds_bucket",
            "fld_feedback_duration_milliseconds_sum",
            "fld_feedback_duration_milliseconds_count",
            "fld_feedback_tokens_total",
            "fld_feedback_spend_usd",
            "fld_feedback_budget_usd");
    }

    [Fact]
    public async Task Feedback_ShouldOfferNoOrderCapability_InItsRoutesOrItsReply()
    {
        var host = Host();
        using var client = host.Client(FeedbackHostFactory.FeedbackViewerKey);
        using var response = await client.PostAsJsonAsync(Feedback, await Plan(client));
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());

        var routes = host.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Select(e => e.RoutePattern.RawText ?? string.Empty).Where(r => r.Contains("feedback", StringComparison.Ordinal)).ToList();
        routes.Should().BeEquivalentTo("/api/plans/feedback/status", "/api/plans/feedback/{instrument}");
        routes.Should().NotContain(r => OrderWords.Any(w => r.Contains(w, StringComparison.OrdinalIgnoreCase)));
        PropertyNames(doc.RootElement).Should().NotContain(n => OrderWords.Any(w => n.Contains(w, StringComparison.OrdinalIgnoreCase)));
    }

    private FeedbackHostFactory Host(Dictionary<string, string?>? overrides = null)
    {
        var host = new FeedbackHostFactory(_upstream, overrides);
        _hosts.Add(host);
        return host;
    }

    private static async Task<object> Plan(HttpClient client, long stopTicks = 19_990)
    {
        using var snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri("/api/snapshot/MES?historyMinutes=1", UriKind.Relative)));
        var contractId = snapshot.RootElement.GetProperty("instrument").GetProperty("contractId").GetString();
        return new
        {
            side = "long",
            entryType = "limit",
            entryTicks = 20_000,
            quantity = 1,
            stopTicks,
            targets = new[] { new { priceTicks = 20_020, quantity = 1 } },
            contractId,
            createdMs = 1_760_000_000_000,
        };
    }

    private static IEnumerable<string> PropertyNames(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject().SelectMany(p => PropertyNames(p.Value).Prepend(p.Name)),
        JsonValueKind.Array => element.EnumerateArray().SelectMany(PropertyNames),
        _ => [],
    };

    private static MeterListener Labels(List<string> labels)
    {
        var listener = new MeterListener
        {
            InstrumentPublished = (instrument, l) => l.EnableMeasurementEvents(instrument),
        };
        void Record(Instrument i, ReadOnlySpan<KeyValuePair<string, object?>> tags)
        {
            lock (labels)
            {
                foreach (var tag in tags)
                {
                    labels.Add($"{i.Name}:{tag.Key}={tag.Value}");
                }
            }
        }

        listener.SetMeasurementEventCallback<long>((i, _, t, _) => Record(i, t));
        listener.SetMeasurementEventCallback<double>((i, _, t, _) => Record(i, t));
        listener.SetMeasurementEventCallback<int>((i, _, t, _) => Record(i, t));
        listener.SetMeasurementEventCallback<decimal>((i, _, t, _) => Record(i, t));
        listener.Start();
        return listener;
    }

    private sealed class CollectingProvider(List<string> lines) : ILoggerProvider
    {
        public ILogger CreateLogger(string categoryName) => new Collecting(lines, categoryName);

        public void Dispose()
        {
        }

        private sealed class Collecting(List<string> lines, string category) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
            {
                lock (lines)
                {
                    lines.Add($"scope {category}: {state}");
                }

                return null;
            }

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            {
                var structured = state is IEnumerable<KeyValuePair<string, object?>> pairs ? string.Join(' ', pairs.Select(p => $"{p.Key}={p.Value}")) : string.Empty;
                lock (lines)
                {
                    lines.Add($"{category}: {formatter(state, exception)} {structured} {exception}");
                }
            }
        }
    }
}
