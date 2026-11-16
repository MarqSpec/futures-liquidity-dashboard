using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using MarqSpec.Client.ProjectX.Exceptions;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: REQUIREMENTS.md FR-7; OBSERVABILITY.md §3 (readiness)
public sealed class IngestionServiceTests
{
    [Fact]
    public async Task Start_ShouldRetryAndStayUnready_WhenContractResolutionFailsAtFirst()
    {
        var resolver = A.Fake<IInstrumentResolver>();
        A.CallTo(() => resolver.ResolveAsync(A<InstrumentSelection>._, A<IReadOnlyList<InstrumentSpec>>._, A<CancellationToken>._))
            .Throws(new InvalidOperationException("upstream detail that must stay in the log")).Once()
            .Then.ReturnsLazily((InstrumentSelection _, IReadOnlyList<InstrumentSpec> specs, CancellationToken _) => Task.FromResult(specs));
        var (service, state, time) = NewService(resolver);

        await service.StartAsync(CancellationToken.None);
        try
        {
            await WaitUntil(() => state.LastError is not null);
            state.LastError.Should().Be(IngestionService.FailedDescription, "readiness must not show the upstream exception");
            state.Ready.Should().BeFalse();
            service.ExecuteTask!.IsCompleted.Should().BeFalse("a failed startup keeps the host up and retries");

            time.Advance(TimeSpan.FromSeconds(1));
            await WaitUntil(() => state.Ready);
            state.LastError.Should().BeNull();
            A.CallTo(() => resolver.ResolveAsync(A<InstrumentSelection>._, A<IReadOnlyList<InstrumentSpec>>._, A<CancellationToken>._)).MustHaveHappenedTwiceExactly();
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Stop_ShouldEndCleanly_WhileStartupIsStillRetrying()
    {
        var resolver = A.Fake<IInstrumentResolver>();
        A.CallTo(() => resolver.ResolveAsync(A<InstrumentSelection>._, A<IReadOnlyList<InstrumentSpec>>._, A<CancellationToken>._))
            .Throws(new InvalidOperationException("always down"));
        var (service, state, _) = NewService(resolver);

        await service.StartAsync(CancellationToken.None);
        await WaitUntil(() => state.LastError is not null);
        await service.StopAsync(CancellationToken.None);

        service.ExecuteTask!.IsCompletedSuccessfully.Should().BeTrue();
        state.Ready.Should().BeFalse();
    }

    [Fact]
    public async Task Start_ShouldDoubleTheRetryDelayUpToThirtySeconds_WhenStartupKeepsFailing()
    {
        // Driven by the fake clock alone. Each step waits for the retry's delay timer to be registered, not for the
        // attempt counter: the counter moves before the timer exists, and advancing in that gap loses the wake-up.
        var attempts = 0;
        var resolver = A.Fake<IInstrumentResolver>();
        A.CallTo(() => resolver.ResolveAsync(A<InstrumentSelection>._, A<IReadOnlyList<InstrumentSpec>>._, A<CancellationToken>._))
            .Invokes(() => Interlocked.Increment(ref attempts))
            .Throws(new InvalidOperationException("still down"));
        var time = new TimerRecordingTimeProvider(TestData.Epoch);
        var (service, _, _) = NewService(resolver, time: time);

        await service.StartAsync(CancellationToken.None);
        try
        {
            var expected = 1;
            foreach (var seconds in new[] { 1, 2, 4, 8, 16, 30, 30 })
            {
                await WaitUntil(() => time.DueTimes.Count == expected);
                time.DueTimes.Last().Should().Be(TimeSpan.FromSeconds(seconds), $"retry {expected} waits {seconds} s");
                time.Advance(TimeSpan.FromSeconds(seconds) - TimeSpan.FromMilliseconds(1));
                Volatile.Read(ref attempts).Should().Be(expected, $"the retry after {seconds} s must not run early");
                time.Advance(TimeSpan.FromMilliseconds(1));
                expected++;
            }

            await WaitUntil(() => time.DueTimes.Count == expected);
            time.DueTimes.Last().Should().Be(TimeSpan.FromSeconds(30), "the delay stays capped at 30 s");
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    public static TheoryData<Exception> PermanentStartupFailures() => new()
    {
        new AuthenticationException("Authentication failed with status code 401 (Unauthorized). Please verify your API credentials."),
        new AuthenticationException("Authentication failed: invalid (errorCode 3: InvalidCredentials)"),
        new InvalidOperationException("wrapper", new AuthenticationException("Authentication failed: x (errorCode 9: ApiSubscriptionNotFound)")),
        new FeedConfigurationException("ProjectX has no contract CON.F.US.MES.TYPO for MES; check Feed:ProjectX:ContractIds:MES."),
    };

    [Theory]
    [MemberData(nameof(PermanentStartupFailures))]
    public async Task Start_ShouldStopWithoutRetrying_WhenTheCredentialsOrConfigurationAreRefused(Exception failure)
    {
        var attempts = 0;
        var resolver = A.Fake<IInstrumentResolver>();
        A.CallTo(() => resolver.ResolveAsync(A<InstrumentSelection>._, A<IReadOnlyList<InstrumentSpec>>._, A<CancellationToken>._))
            .Invokes(() => Interlocked.Increment(ref attempts))
            .Throws(failure);
        var (service, state, time) = NewService(resolver);

        await service.StartAsync(CancellationToken.None);
        try
        {
            await service.ExecuteTask!.WaitAsync(TimeSpan.FromSeconds(10));
            time.Advance(TimeSpan.FromMinutes(5));

            Volatile.Read(ref attempts).Should().Be(1, "a refused login or a bad setting fails the same way every time");
            state.LastError.Should().Be(IngestionService.StoppedDescription, "readiness must not show the upstream exception");
            state.Ready.Should().BeFalse();
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Start_ShouldKeepRetrying_WhenTheLoginFailsWithAServerError()
    {
        var resolver = A.Fake<IInstrumentResolver>();
        A.CallTo(() => resolver.ResolveAsync(A<InstrumentSelection>._, A<IReadOnlyList<InstrumentSpec>>._, A<CancellationToken>._))
            .Throws(new AuthenticationException("Authentication failed with status code 503 (ServiceUnavailable). Please verify your API credentials.")).Once()
            .Then.ReturnsLazily((InstrumentSelection _, IReadOnlyList<InstrumentSpec> specs, CancellationToken _) => Task.FromResult(specs));
        var (service, state, time) = NewService(resolver);

        await service.StartAsync(CancellationToken.None);
        try
        {
            await WaitUntil(() => state.LastError is not null);
            state.LastError.Should().Be(IngestionService.FailedDescription);

            time.Advance(TimeSpan.FromSeconds(1));
            await WaitUntil(() => state.Ready);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Stream_ShouldStopWithoutRestartingAndShowDisconnected_WhenTheLoginIsRefusedMidSession()
    {
        var resolver = A.Fake<IInstrumentResolver>();
        A.CallTo(() => resolver.ResolveAsync(A<InstrumentSelection>._, A<IReadOnlyList<InstrumentSpec>>._, A<CancellationToken>._))
            .ReturnsLazily((InstrumentSelection _, IReadOnlyList<InstrumentSpec> specs, CancellationToken _) => Task.FromResult(specs));
        var feed = new RefusedAfterConnectFeed();
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var (service, state, time) = NewService(resolver, feed, registry);

        await service.StartAsync(CancellationToken.None);
        try
        {
            // The engines' clock keeps ticking after the stream stops, so the service itself runs on until the host stops.
            await WaitUntil(() => state.LastError is not null);
            // A retry would sleep on this clock (1 s, doubling to 30 s). Stepping it must not open the stream again.
            for (var i = 0; i < 10; i++)
            {
                await AdvanceAsync(time, TimeSpan.FromSeconds(30));
            }

            feed.Starts.Should().Be(1, "the stream is not restarted against a login the gateway refuses");
            state.LastError.Should().Be(IngestionService.StoppedDescription);
            registry.TryGet(InstrumentRoot.MES, out var engine).Should().BeTrue();
            engine!.Status().Connected.Should().BeFalse("a stopped feed never shows the last book as live");
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Start_ShouldWarnOnce_WhenTheRetiredSignalRetentionKeyIsSet()
    {
        var logger = A.Fake<ILogger<IngestionService>>();
        A.CallTo(() => logger.IsEnabled(A<LogLevel>._)).Returns(true);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:OrderFlow:SignalRetention"] = "100",
        }).Build();
        var service = new IngestionService(
            new OneEventFeed(),
            new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar()),
            Options.Create(new FeedOptions { TickMs = 250, WarmRegimes = false }),
            TestData.Calendar(),
            new IngestionState { FeedName = "test" },
            new FakeTimeProvider(TestData.Epoch),
            logger,
            configuration: configuration);

        await service.StartAsync(CancellationToken.None);
        try
        {
            await WaitUntil(() => Fake.GetCalls(logger).Any(call =>
                call.Method.Name == nameof(ILogger.Log)
                && call.GetArgument<EventId>(1).Name == "RetiredSignalRetention"));
            Fake.GetCalls(logger).Count(call =>
                call.Method.Name == nameof(ILogger.Log)
                && call.GetArgument<LogLevel>(0) == LogLevel.Warning
                && call.GetArgument<EventId>(1).Name == "RetiredSignalRetention").Should().Be(1);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Tick_ShouldLogOneClockAheadWarningPerMinute_WhenEventsAreRefusedForTheirTimestamps()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var feed = new ChannelFeed();
        var time = new FakeTimeProvider(TestData.Epoch);
        var logger = A.Fake<ILogger<IngestionService>>();
        A.CallTo(() => logger.IsEnabled(A<LogLevel>._)).Returns(true);
        var service = new IngestionService(
            feed,
            registry,
            Options.Create(new FeedOptions { TickMs = 250, WarmRegimes = false }),
            TestData.Calendar(),
            new IngestionState { FeedName = "test" },
            time,
            logger);

        await service.StartAsync(CancellationToken.None);
        try
        {
            registry.TryGet(InstrumentRoot.MES, out var engine).Should().BeTrue();
            var spec = engine!.Spec;
            for (var i = 0; i < 3; i++)
            {
                var source = TestData.EpochMs + (i * 1_000);
                await feed.Events.Writer.WriteAsync(TestData.Trade(source, TestData.EsBase, 1, BookSide.Bid, $"ahead-{i}") with
                {
                    Root = spec.Root,
                    ContractId = spec.ContractId,
                    ReceivedTimeMs = source - 120_000,
                });
            }

            await WaitUntil(() => engine.ClockAheadRejectedEvents == 3);
            time.Advance(TimeSpan.FromMilliseconds(250));
            await WaitUntil(() => ClockAheadWarnings(logger) == 1);
            var loggedAt = time.GetUtcNow().ToUnixTimeMilliseconds();

            for (var i = 0; i < 3; i++)
            {
                var source = TestData.EpochMs + 30_000 + (i * 1_000);
                await feed.Events.Writer.WriteAsync(TestData.Trade(source, TestData.EsBase, 1, BookSide.Bid, $"ahead-later-{i}") with
                {
                    Root = spec.Root,
                    ContractId = spec.ContractId,
                    ReceivedTimeMs = source - 120_000,
                });
            }

            await WaitUntil(() => engine.ClockAheadRejectedEvents == 6);
            time.Advance(TimeSpan.FromSeconds(59));
            var withinMinute = time.GetUtcNow().ToUnixTimeMilliseconds();
            (withinMinute - loggedAt).Should().BeLessThan(60_000);
            await WaitUntil(() => engine.Snapshot(60, null).ServerTimeMs >= withinMinute);
            ClockAheadWarnings(logger).Should().Be(1, "the next line waits until a minute after the first");

            time.Advance(TimeSpan.FromSeconds(1));
            var afterMinute = time.GetUtcNow().ToUnixTimeMilliseconds();
            (afterMinute - loggedAt).Should().BeGreaterThanOrEqualTo(60_000);
            await WaitUntil(() => ClockAheadWarnings(logger) == 2);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Tick_ShouldLogOneLateSignalWarningPerMinute_WhenASignalIsStampedBehindTheNewest()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var time = new FakeTimeProvider(TestData.Epoch);
        var logger = A.Fake<ILogger<IngestionService>>();
        A.CallTo(() => logger.IsEnabled(A<LogLevel>._)).Returns(true);
        var services = new ServiceCollection();
        services.AddMetrics();
        using var provider = services.BuildServiceProvider();
        var meters = provider.GetRequiredService<IMeterFactory>();
        var metrics = new IngestMetrics(meters);
        long metered = 0;
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            // A meter made by a factory carries that factory as its Scope, so this counts only this test's meter.
            if (ReferenceEquals(instrument.Meter.Scope, meters) && instrument.Name == "fld.orderflow.late_signals_dropped")
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((_, value, _, _) => metered += value);
        listener.Start();
        metrics.AddDroppedLateSignals(0);
        metered.Should().Be(0);

        var feed = new ChannelFeed();
        var service = new IngestionService(
            feed,
            registry,
            Options.Create(new FeedOptions { TickMs = 250, WarmRegimes = false }),
            TestData.Calendar(),
            new IngestionState { FeedName = "test" },
            time,
            logger,
            metrics: metrics);
        registry.TryGet(InstrumentRoot.MES, out var engine).Should().BeTrue();
        var signals = SignalsOf(engine!);
        signals.Add(SignalKind.Spoof, SignalBias.Bearish, TestData.EpochMs + 5_000, 100, 100, 0.5, "spoof", "synthetic");
        signals.Add(SignalKind.LiquiditySweep, SignalBias.Bearish, TestData.EpochMs + 1_000, 100, 100, 0.5, "sweep", "synthetic");
        signals.Add(SignalKind.Iceberg, SignalBias.Bullish, TestData.EpochMs + 2_000, 100, 100, 0.5, "iceberg", "synthetic");
        engine!.LateSignalsDropped.Should().Be(2);

        await service.StartAsync(CancellationToken.None);
        try
        {
            var seen = TestData.Trade(TestData.EpochMs + 10_000, TestData.EsBase + 40, 1, BookSide.Bid, "seen");
            await feed.Events.Writer.WriteAsync(seen);
            await WaitUntil(() => engine.Summary().Last == TestData.EsBase + 40);
            time.Advance(TimeSpan.FromMilliseconds(250));
            await WaitUntil(() => LateSignalWarnings(logger) == 1);
            await WaitUntil(() => metered == 2);
            var loggedAt = time.GetUtcNow().ToUnixTimeMilliseconds();

            lock (EngineGate(engine))
            {
                signals.Add(SignalKind.Spoof, SignalBias.Bearish, TestData.EpochMs + 500, 100, 100, 0.5, "late", "synthetic");
            }

            engine.LateSignalsDropped.Should().Be(3);
            time.Advance(TimeSpan.FromSeconds(59));
            var withinMinute = time.GetUtcNow().ToUnixTimeMilliseconds();
            (withinMinute - loggedAt).Should().BeLessThan(60_000);
            await WaitUntil(() => engine.Snapshot(60, null).ServerTimeMs >= withinMinute);
            LateSignalWarnings(logger).Should().Be(1, "the next line waits until a minute after the first");
            metered.Should().Be(3, "the counter grows on the tick even while the log line waits");

            time.Advance(TimeSpan.FromSeconds(1));
            var afterMinute = time.GetUtcNow().ToUnixTimeMilliseconds();
            (afterMinute - loggedAt).Should().BeGreaterThanOrEqualTo(60_000);
            await WaitUntil(() => LateSignalWarnings(logger) == 2);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    private static SignalLog SignalsOf(InstrumentEngine engine)
    {
        var flow = typeof(InstrumentEngine).GetField("_orderFlow", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(engine);
        return (SignalLog)flow!.GetType().GetProperty("Signals")!.GetValue(flow)!;
    }

    private static object EngineGate(InstrumentEngine engine) =>
        typeof(InstrumentEngine).GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(engine)!;

    private static int LateSignalWarnings(ILogger logger) =>
        Fake.GetCalls(logger).Count(call =>
            call.Method.Name == nameof(ILogger.Log)
            && call.GetArgument<LogLevel>(0) == LogLevel.Warning
            && call.GetArgument<EventId>(1).Name == "LateSignalsDropped");

    private static int ClockAheadWarnings(ILogger logger) =>
        Fake.GetCalls(logger).Count(call =>
            call.Method.Name == nameof(ILogger.Log)
            && call.GetArgument<LogLevel>(0) == LogLevel.Warning
            && call.GetArgument<EventId>(1).Name == "ClockAheadRejected");

    [Fact]
    public async Task Prepare_ShouldLoadEnoughHistoryForTheSlowestRegime_ForEveryProductAtOnce()
    {
        // Mid-session, a few hours after the open: the 15-minute regime needs 28 bars (7 h), more than the 4 h minimum.
        var now = TestData.SessionOpen.AddHours(5);
        var registry = new EngineRegistry([InstrumentRoot.ES, InstrumentRoot.GC, InstrumentRoot.CL], EngineOptions.Default, TestData.Calendar());
        var history = new RecordingHistory(waitForSibling: true);
        var service = new IngestionService(
            new OneEventFeed(),
            registry,
            Options.Create(new FeedOptions { MinHistoryHours = 4, HistoryConcurrency = 3 }),
            TestData.Calendar(),
            new IngestionState { FeedName = "test" },
            new FakeTimeProvider(now),
            NullLogger<IngestionService>.Instance,
            history);

        await service.PrepareAsync(CancellationToken.None);

        history.Windows.Should().HaveCount(3);
        history.Windows.Values.Should().OnlyContain(w => w.ToMs - w.FromMs == (long)TimeSpan.FromHours(7).TotalMilliseconds);
        history.MaxConcurrent.Should().BeGreaterThan(1);
    }

    [Fact]
    public async Task Prepare_ShouldKeepToMinHistoryHours_WhenRegimeWarmupIsOff()
    {
        var now = TestData.SessionOpen.AddHours(5);
        var registry = new EngineRegistry([InstrumentRoot.ES], EngineOptions.Default, TestData.Calendar());
        var history = new RecordingHistory();
        var service = new IngestionService(
            new OneEventFeed(),
            registry,
            Options.Create(new FeedOptions { MinHistoryHours = 0.5, WarmRegimes = false }),
            TestData.Calendar(),
            new IngestionState { FeedName = "test" },
            new FakeTimeProvider(now),
            NullLogger<IngestionService>.Instance,
            history);

        await service.PrepareAsync(CancellationToken.None);

        var window = history.Windows[InstrumentRoot.ES];
        (window.ToMs - window.FromMs).Should().BeLessThan((long)TimeSpan.FromHours(7).TotalMilliseconds);
    }

    private static (IngestionService Service, IngestionState State, FakeTimeProvider Time) NewService(
        IInstrumentResolver resolver,
        IMarketDataFeed? feed = null,
        EngineRegistry? registry = null,
        FakeTimeProvider? time = null)
    {
        registry ??= new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var state = new IngestionState { FeedName = "test" };
        time ??= new FakeTimeProvider(TestData.Epoch);
        var service = new IngestionService(
            feed ?? new OneEventFeed(),
            registry,
            Options.Create(new FeedOptions()),
            TestData.Calendar(),
            state,
            time,
            NullLogger<IngestionService>.Instance,
            history: null,
            resolver: resolver);
        return (service, state, time);
    }

    [Fact]
    public async Task Stream_ShouldMarkTheContractMissing_WhenTheFeedReportsATradeGap()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var feed = new GapMarkFeed();
        var service = new IngestionService(
            feed,
            registry,
            Options.Create(new FeedOptions { TickMs = 250, WarmRegimes = false }),
            TestData.Calendar(),
            new IngestionState { FeedName = "test" },
            new FakeTimeProvider(TestData.Epoch),
            NullLogger<IngestionService>.Instance);

        await service.StartAsync(CancellationToken.None);
        try
        {
            await feed.Marked.Task;
            registry.TryGet(InstrumentRoot.MES, out var marked).Should().BeTrue();
            marked!.Status().MissingSinceMs.Should().Be(TestData.EpochMs + 15_000);
            marked.Status().CvdKnown.Should().BeFalse();
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Stream_ShouldApplyTheNextLiveTrade_WhenGapRepairIsStillReadingHistory()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new HoldingBars(release);
        var feed = new GapThenTradeFeed();
        var service = new IngestionService(
            feed,
            registry,
            Options.Create(new FeedOptions { TickMs = 250, WarmRegimes = false }),
            TestData.Calendar(),
            new IngestionState { FeedName = "test" },
            new FakeTimeProvider(TestData.Epoch.AddDays(1)),
            NullLogger<IngestionService>.Instance,
            minutes: source);

        var repair = service.WhenNextRepairEnds(InstrumentRoot.MES);
        await service.StartAsync(CancellationToken.None);
        try
        {
            await feed.Yielded.Task.WaitAsync(TimeSpan.FromSeconds(5));
            registry.TryGet(InstrumentRoot.MES, out var engine).Should().BeTrue();
            engine!.Summary().Last.Should().Be(TestData.EsBase + 5);
            engine.Snapshot(60, null).MinuteBars.Should().NotContain(bar => bar.T == TestData.EpochMs + 60_000 && bar.V == 40);

            release.TrySetResult();
            var result = await repair.WaitAsync(TimeSpan.FromSeconds(5));

            result.MinutesWritten.Should().BeGreaterThan(0);
            engine.Snapshot(60, null).MinuteBars.Should().Contain(bar => bar.T == TestData.EpochMs + 60_000 && bar.V == 40);
            engine.Summary().Last.Should().Be(TestData.EsBase + 5);
            engine.Summary().LastTradeMs.Should().Be(TestData.EpochMs + 200_000);
            engine.Status().Code.Should().Be("DEGRADED");
            engine.Status().CvdKnown.Should().BeFalse();
        }
        finally
        {
            release.TrySetResult();
            await service.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task Stream_ShouldRepairAgain_WhenTheHoleGainsAnEndAfterTheOpenHoleCap()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new TwoPassBars(release);
        var feed = new GapThenResubscribeFeed(resume);
        var service = new IngestionService(
            feed,
            registry,
            Options.Create(new FeedOptions { TickMs = 250, WarmRegimes = false }),
            TestData.Calendar(),
            new IngestionState { FeedName = "test" },
            new FakeTimeProvider(TestData.Epoch.AddDays(1)),
            NullLogger<IngestionService>.Instance,
            minutes: source,
            repairMaxOpenHoleAttempts: 1);

        var first = service.WhenNextRepairEnds(InstrumentRoot.MES);
        await service.StartAsync(CancellationToken.None);
        try
        {
            await feed.Holding.Task.WaitAsync(TimeSpan.FromSeconds(5));
            release.TrySetResult();
            var paused = await first.WaitAsync(TimeSpan.FromSeconds(5));
            paused.Completed.Should().BeFalse();
            await service.WhenRepairIdle(InstrumentRoot.MES);

            var second = service.WhenNextRepairEnds(InstrumentRoot.MES);
            resume.TrySetResult();
            var done = await second.WaitAsync(TimeSpan.FromSeconds(5));

            done.Completed.Should().BeTrue();
            registry.TryGet(InstrumentRoot.MES, out var engine).Should().BeTrue();
            engine!.Snapshot(60, null).MinuteBars.Should().Contain(bar => bar.T == TestData.EpochMs + 60_000 && bar.V == 40);
            engine.Status().Code.Should().Be("DEGRADED");
            engine.Status().CvdKnown.Should().BeTrue();
        }
        finally
        {
            release.TrySetResult();
            resume.TrySetResult();
            await service.StopAsync(CancellationToken.None);
        }
    }

    /// <summary>
    /// Moves <paramref name="time"/> by <paramref name="by"/> and lets the delays that woke finish.
    /// The wait is the fake clock's timer, not a wall-clock sleep.
    /// </summary>
    private static async Task AdvanceAsync(FakeTimeProvider time, TimeSpan by)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var timer = time.CreateTimer(_ => done.TrySetResult(), null, by, Timeout.InfiniteTimeSpan);
        time.Advance(by);
        await done.Task;
        // A delay the advance completed continues on the pool. Yield until that continuation has run.
        for (var i = 0; i < 8; i++)
        {
            await Task.Yield();
        }
    }

    /// <summary>A fake clock that records the due time of every timer, so a test can see a delay the moment it is scheduled.</summary>
    private sealed class TimerRecordingTimeProvider(DateTimeOffset start) : FakeTimeProvider(start)
    {
        public ConcurrentQueue<TimeSpan> DueTimes { get; } = new();

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = base.CreateTimer(callback, state, dueTime, period);
            DueTimes.Enqueue(dueTime);
            return timer;
        }
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (!condition())
        {
            await Task.Delay(20, timeout.Token);
        }
    }

    /// <summary>Connects with a known book, then reports one dropped trade.</summary>
    private sealed class GapMarkFeed : IMarketDataFeed
    {
        public TaskCompletionSource Marked { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public string Name => "gap";

        public FeedProvenance Provenance => FeedProvenance.Simulated;

        public async IAsyncEnumerable<MarketEvent> StreamAsync(
            IReadOnlyList<InstrumentSpec> instruments,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            var spec = instruments[0];
            yield return TestData.Status(TestData.EpochMs, connected: true) with { DepthSubscribed = false };
            yield return new TradeGapEvent
            {
                Root = spec.Root,
                ContractId = spec.ContractId,
                SourceTimeMs = TestData.EpochMs + 15_000,
                ReceivedTimeMs = TestData.EpochMs + 15_000,
                Epoch = 1,
                Sequence = 2,
                GapStartMs = TestData.EpochMs + 15_000,
                Provenance = FeedProvenance.Simulated,
                DepthSubscribed = false,
            };
            Marked.TrySetResult();
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }
    }

    /// <summary>Yields whatever the test writes, until cancelled.</summary>
    private sealed class ChannelFeed : IMarketDataFeed
    {
        public Channel<MarketEvent> Events { get; } = Channel.CreateUnbounded<MarketEvent>();

        public string Name => "channel";

        public FeedProvenance Provenance => FeedProvenance.Simulated;

        public IAsyncEnumerable<MarketEvent> StreamAsync(IReadOnlyList<InstrumentSpec> instruments, CancellationToken cancellationToken) =>
            Events.Reader.ReadAllAsync(cancellationToken);
    }

    /// <summary>Connects, then fails the way a token refresh does when the account's login is refused.</summary>
    private sealed class RefusedAfterConnectFeed : IMarketDataFeed
    {
        private int _starts;

        public int Starts => Volatile.Read(ref _starts);

        public string Name => "refused";

        public FeedProvenance Provenance => FeedProvenance.Live;

        public async IAsyncEnumerable<MarketEvent> StreamAsync(
            IReadOnlyList<InstrumentSpec> instruments,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _starts);
            yield return TestData.Status(TestData.EpochMs, connected: true);
            await Task.Yield();
            throw new AuthenticationException("Authentication failed with status code 401 (Unauthorized). Please verify your API credentials.");
        }
    }

    /// <summary>Yields one status event, then idles until cancelled.</summary>
    private sealed class OneEventFeed : IMarketDataFeed
    {
        public string Name => "test";

        public FeedProvenance Provenance => FeedProvenance.Simulated;

        public async IAsyncEnumerable<MarketEvent> StreamAsync(
            IReadOnlyList<InstrumentSpec> instruments,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            yield return TestData.Status(TestData.EpochMs, connected: true);
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }
    }

    /// <summary>Records each window asked for, and how many requests overlapped.</summary>
    private sealed class RecordingHistory(bool waitForSibling = false) : IHistoricalTradeSource
    {
        private int _running;
        private int _entered;
        private readonly TaskCompletionSource _sibling = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public System.Collections.Concurrent.ConcurrentDictionary<InstrumentRoot, (long FromMs, long ToMs)> Windows { get; } = new();

        public int MaxConcurrent { get; private set; }

        public async Task<IReadOnlyList<TradeEvent>> GetTradesAsync(InstrumentSpec instrument, long fromMs, long toMs, CancellationToken cancellationToken)
        {
            var running = Interlocked.Increment(ref _running);
            lock (Windows)
            {
                MaxConcurrent = Math.Max(MaxConcurrent, running);
            }

            Windows[instrument.Root] = (fromMs, toMs);
            // The first call stays in until a second has entered. A bare Task.Yield returns before
            // Parallel.ForEachAsync starts the next product when the pool is busy, so they never overlap.
            if (waitForSibling)
            {
                if (Interlocked.Increment(ref _entered) >= 2)
                {
                    _sibling.TrySetResult();
                }
                else
                {
                    await _sibling.Task.WaitAsync(TimeSpan.FromSeconds(2), cancellationToken);
                }
            }

            Interlocked.Decrement(ref _running);
            return [];
        }
    }

    /// <summary>A known book, one print, a dropped-trade hole, then a later print that must not wait on history.</summary>
    private sealed class GapThenTradeFeed : IMarketDataFeed
    {
        public TaskCompletionSource Yielded { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public string Name => "gap-then-trade";

        public FeedProvenance Provenance => FeedProvenance.Simulated;

        public async IAsyncEnumerable<MarketEvent> StreamAsync(
            IReadOnlyList<InstrumentSpec> instruments,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            var spec = instruments[0];
            var root = spec.Root;
            var contract = spec.ContractId;
            yield return TestData.Status(TestData.EpochMs, connected: true) with { Root = root, ContractId = contract };
            yield return TestData.Snapshot(TestData.EpochMs) with { Root = root, ContractId = contract };
            yield return TestData.Trade(TestData.EpochMs + 1_000, TestData.EsBase, 1, BookSide.Bid, "before") with
            {
                Root = root,
                ContractId = contract,
            };
            yield return new TradeGapEvent
            {
                Root = root,
                ContractId = contract,
                SourceTimeMs = TestData.EpochMs + 60_000,
                ReceivedTimeMs = TestData.EpochMs + 60_000,
                Epoch = 1,
                Sequence = 4,
                GapStartMs = TestData.EpochMs + 60_000,
                Provenance = FeedProvenance.Simulated,
            };
            yield return TestData.Trade(TestData.EpochMs + 200_000, TestData.EsBase + 5, 1, BookSide.Bid, "after") with
            {
                Root = root,
                ContractId = contract,
            };
            Yielded.TrySetResult();
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }
    }

    /// <summary>Yields a hole, waits, then closes it with a resubscribe snapshot.</summary>
    private sealed class GapThenResubscribeFeed(TaskCompletionSource Resume) : IMarketDataFeed
    {
        public TaskCompletionSource Holding { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public string Name => "gap-then-resubscribe";

        public FeedProvenance Provenance => FeedProvenance.Simulated;

        public async IAsyncEnumerable<MarketEvent> StreamAsync(
            IReadOnlyList<InstrumentSpec> instruments,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            var spec = instruments[0];
            var root = spec.Root;
            var contract = spec.ContractId;
            yield return TestData.Status(TestData.EpochMs, connected: true) with { Root = root, ContractId = contract };
            yield return TestData.Snapshot(TestData.EpochMs) with { Root = root, ContractId = contract };
            yield return TestData.Trade(TestData.EpochMs + 1_000, TestData.EsBase, 1, BookSide.Bid, "before-cap") with
            {
                Root = root,
                ContractId = contract,
            };
            yield return new TradeGapEvent
            {
                Root = root,
                ContractId = contract,
                SourceTimeMs = TestData.EpochMs + 60_000,
                ReceivedTimeMs = TestData.EpochMs + 60_000,
                Epoch = 1,
                Sequence = 4,
                GapStartMs = TestData.EpochMs + 60_000,
                Provenance = FeedProvenance.Simulated,
            };
            yield return TestData.Trade(TestData.EpochMs + 200_000, TestData.EsBase + 3, 1, BookSide.Bid, "cursor") with
            {
                Root = root,
                ContractId = contract,
            };
            Holding.TrySetResult();
            await Resume.Task.WaitAsync(cancellationToken);
            yield return new BookResetEvent
            {
                Root = root,
                ContractId = contract,
                SourceTimeMs = TestData.EpochMs + 300_000,
                ReceivedTimeMs = TestData.EpochMs + 300_000,
                Epoch = 2,
                Sequence = 1,
                Reason = BookResetEvent.SubscribedReason,
            };
            yield return TestData.Snapshot(TestData.EpochMs + 300_000) with
            {
                Root = root,
                ContractId = contract,
                Resubscribe = true,
                GatewayTimeMs = TestData.EpochMs + 300_000,
                Epoch = 2,
            };
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }
    }

    /// <summary>The first read returns nothing. The next read returns the closed minutes through the hole's end.</summary>
    private sealed class TwoPassBars(TaskCompletionSource Release) : IMinuteBarSource
    {
        private int _calls;

        public async Task<IReadOnlyList<HistoricalMinuteBar>> GetClosedMinuteBarsAsync(
            InstrumentSpec instrument,
            long fromMs,
            long toMs,
            CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _calls) == 1)
            {
                await Release.Task.WaitAsync(cancellationToken);
                return [];
            }

            return
            [
                new HistoricalMinuteBar(TestData.EpochMs + 60_000, TestData.EsBase - 1, TestData.EsBase + 2, TestData.EsBase - 2, TestData.EsBase + 1, 40),
                new HistoricalMinuteBar(TestData.EpochMs + 120_000, TestData.EsBase - 1, TestData.EsBase + 2, TestData.EsBase - 2, TestData.EsBase + 1, 8),
                new HistoricalMinuteBar(TestData.EpochMs + 180_000, TestData.EsBase - 1, TestData.EsBase + 2, TestData.EsBase - 2, TestData.EsBase + 1, 8),
                new HistoricalMinuteBar(TestData.EpochMs + 240_000, TestData.EsBase - 1, TestData.EsBase + 2, TestData.EsBase - 2, TestData.EsBase + 1, 8),
            ];
        }
    }

    /// <summary>Holds the history read until the test releases it, then returns the closed minute inside the hole.</summary>
    private sealed class HoldingBars(TaskCompletionSource Release) : IMinuteBarSource
    {
        public async Task<IReadOnlyList<HistoricalMinuteBar>> GetClosedMinuteBarsAsync(
            InstrumentSpec instrument,
            long fromMs,
            long toMs,
            CancellationToken cancellationToken)
        {
            await Release.Task.WaitAsync(cancellationToken);
            return
            [
                new HistoricalMinuteBar(TestData.EpochMs + 60_000, TestData.EsBase - 1, TestData.EsBase + 2, TestData.EsBase - 2, TestData.EsBase + 1, 40),
            ];
        }
    }
}
