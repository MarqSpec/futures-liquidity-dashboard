using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

public sealed class GapRepairWorkerTests
{
    private const long Px = TestData.EsBase;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public async Task Run_ShouldClearTheArmedFlag_WhenNothingIsPending()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var engine = registry.All[0];
        Prime(engine);
        var source = new ScriptedBars((_, _, _, _) => Task.FromResult<IReadOnlyList<HistoricalMinuteBar>>([]));
        var worker = new GapRepairWorker(source, registry, new ManualTime(TestData.Epoch.AddMinutes(10)), NullLogger.Instance);
        try
        {
            var attempt = worker.WhenNextAttemptEnds(InstrumentRoot.MES);
            worker.Schedule(engine);
            var result = await attempt.WaitAsync(TimeSpan.FromSeconds(5));

            result.Completed.Should().BeTrue();
            result.MinutesWritten.Should().Be(0);
            engine.Status().Code.Should().Be("SIMULATED");
        }
        finally
        {
            await worker.StopAsync();
            worker.Dispose();
        }
    }

    [Fact]
    public async Task Run_ShouldRetryUntilTheCoveringBarArrives_WhenTheFirstReadStopsShort()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var engine = registry.All[0];
        Prime(engine);
        engine.MarkMissing(T0 + 60_000);
        Resubscribe(engine, T0 + 180_000);
        var calls = 0;
        var source = new ScriptedBars((spec, from, to, _) =>
        {
            spec.Root.Should().Be(InstrumentRoot.MES);
            from.Should().Be(T0 + 60_000);
            to.Should().Be(T0 + 180_000);
            calls++;
            IReadOnlyList<HistoricalMinuteBar> bars = calls == 1
                ? [Bar(T0 + 60_000, 9)]
                : [Bar(T0 + 60_000, 9), Bar(T0 + 120_000, 11)];
            return Task.FromResult(bars);
        });
        var delay = new AdvanceableDelay();
        var worker = new GapRepairWorker(
            source,
            registry,
            new ManualTime(TestData.Epoch.AddMinutes(10)),
            NullLogger.Instance,
            delay.Wait,
            initialBackoffMs: 1_000,
            maxBackoffMs: 8_000,
            maxOpenHoleAttempts: 1);
        try
        {
            var first = worker.WhenNextAttemptEnds(InstrumentRoot.MES);
            worker.Schedule(engine);
            var partial = await first.WaitAsync(TimeSpan.FromSeconds(5));

            partial.Completed.Should().BeFalse();
            partial.MinutesWritten.Should().BeGreaterThan(0);
            delay.Pending.Should().Be(TimeSpan.FromSeconds(1));

            var second = worker.WhenNextAttemptEnds(InstrumentRoot.MES);
            delay.Advance(TimeSpan.FromSeconds(1));
            var done = await second.WaitAsync(TimeSpan.FromSeconds(5));

            done.Completed.Should().BeTrue();
            calls.Should().Be(2);
            engine.Status().Code.Should().Be("DEGRADED");
            engine.Summary().Last.Should().Be(Px);
        }
        finally
        {
            await worker.StopAsync();
            worker.Dispose();
        }
    }

    [Fact]
    public async Task Run_ShouldFinishTheOtherContract_WhenOneHistoryReadIsStillOpen()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES, InstrumentRoot.MCL], EngineOptions.Default, TestData.Calendar());
        var mes = registry.All.Single(engine => engine.Spec.Root == InstrumentRoot.MES);
        var mcl = registry.All.Single(engine => engine.Spec.Root == InstrumentRoot.MCL);
        Prime(mes);
        Prime(mcl, InstrumentCatalog.MCL);
        mes.MarkMissing(T0 + 60_000);
        mcl.MarkMissing(T0 + 60_000);
        Resubscribe(mes, T0 + 120_000);
        Resubscribe(mcl, T0 + 120_000, InstrumentCatalog.MCL);
        var releaseMes = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new ScriptedBars(async (spec, _, _, token) =>
        {
            if (spec.Root == InstrumentRoot.MES)
            {
                await releaseMes.Task.WaitAsync(token);
            }

            return [Bar(T0 + 60_000, 5)];
        });
        var worker = new GapRepairWorker(source, registry, new ManualTime(TestData.Epoch.AddMinutes(10)), NullLogger.Instance);
        try
        {
            var mesAttempt = worker.WhenNextAttemptEnds(InstrumentRoot.MES);
            var mclAttempt = worker.WhenNextAttemptEnds(InstrumentRoot.MCL);
            worker.Schedule(mes);
            worker.Schedule(mcl);

            var mclResult = await mclAttempt.WaitAsync(TimeSpan.FromSeconds(5));

            mclResult.Completed.Should().BeTrue();
            mesAttempt.IsCompleted.Should().BeFalse();
            releaseMes.TrySetResult();
            (await mesAttempt.WaitAsync(TimeSpan.FromSeconds(5))).Completed.Should().BeTrue();
        }
        finally
        {
            releaseMes.TrySetResult();
            await worker.StopAsync();
            worker.Dispose();
        }
    }

    [Fact]
    public async Task Run_ShouldCoverAGapThatArrivesDuringTheRead_WhenItDoesNotOverlap()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var engine = registry.All[0];
        Prime(engine);
        engine.Tick(T0 + 360_000);
        engine.MarkMissing(T0 + 60_000);
        Resubscribe(engine, T0 + 120_000);
        var pass = 0;
        GapRepairWorker? worker = null;
        var source = new ScriptedBars((_, _, _, _) =>
        {
            pass++;
            if (pass == 1)
            {
                engine.MarkMissing(T0 + 180_000);
                worker!.Schedule(engine);
                return Task.FromResult<IReadOnlyList<HistoricalMinuteBar>>([Bar(T0 + 60_000, 4)]);
            }

            Resubscribe(engine, T0 + 240_000);
            return Task.FromResult<IReadOnlyList<HistoricalMinuteBar>>([Bar(T0 + 180_000, 8)]);
        });
        var delay = new AdvanceableDelay();
        worker = new GapRepairWorker(
            source,
            registry,
            new ManualTime(TestData.Epoch.AddMinutes(10)),
            NullLogger.Instance,
            delay.Wait,
            initialBackoffMs: 5_000);
        try
        {
            var first = worker.WhenNextAttemptEnds(InstrumentRoot.MES);
            worker.Schedule(engine);
            var partial = await first.WaitAsync(TimeSpan.FromSeconds(5));
            partial.Completed.Should().BeFalse();

            var second = worker.WhenNextAttemptEnds(InstrumentRoot.MES);
            var done = await second.WaitAsync(TimeSpan.FromSeconds(5));

            done.Completed.Should().BeTrue();
            delay.Pending.Should().BeNull("a gap that arrives during the read retries without waiting out the backoff");
            pass.Should().Be(2);
            engine.Snapshot(60, null).MinuteBars.Should().Contain(bar => bar.T == T0 + 60_000 && bar.V == 4);
            engine.Snapshot(60, null).MinuteBars.Should().Contain(bar => bar.T == T0 + 180_000 && bar.V == 8);
        }
        finally
        {
            await worker.StopAsync();
            worker.Dispose();
        }
    }

    [Fact]
    public async Task Run_ShouldPauseAndDropTheSlot_WhenAnOpenHoleHasNoEndBar()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var engine = registry.All[0];
        Prime(engine);
        engine.MarkMissing(T0 + 60_000);
        var calls = 0;
        var source = new ScriptedBars((_, _, _, _) =>
        {
            calls++;
            IReadOnlyList<HistoricalMinuteBar> bars = calls <= 2
                ? [Bar(T0 + 60_000, 9)]
                : [Bar(T0 + 60_000, 9), Bar(T0 + 120_000, 11)];
            return Task.FromResult(bars);
        });
        var delay = new AdvanceableDelay();
        var log = new CollectingLogger();
        var worker = new GapRepairWorker(
            source,
            registry,
            new ManualTime(TestData.Epoch.AddMinutes(10)),
            log,
            delay.Wait,
            initialBackoffMs: 1_000,
            maxOpenHoleAttempts: 2);
        try
        {
            var first = worker.WhenNextAttemptEnds(InstrumentRoot.MES);
            worker.Schedule(engine);
            (await first.WaitAsync(TimeSpan.FromSeconds(5))).Completed.Should().BeFalse();

            var second = worker.WhenNextAttemptEnds(InstrumentRoot.MES);
            // The attempt is signalled before the backoff wait is armed. Advancing first drops the tick.
            await delay.UntilPending(TimeSpan.FromSeconds(1));
            delay.Advance(TimeSpan.FromSeconds(1));
            var paused = await second.WaitAsync(TimeSpan.FromSeconds(5));
            await worker.WhenIdle(InstrumentRoot.MES);

            paused.Completed.Should().BeFalse();
            calls.Should().Be(2);
            worker.LiveSlots.Should().Be(0);
            log.Lines.Should().Contain(line => line.Contains("paused", StringComparison.OrdinalIgnoreCase)
                && line.Contains("DEGRADED", StringComparison.OrdinalIgnoreCase));
            engine.Status().Code.Should().Be("DEGRADED");
            engine.RepairAwaitsEndBar().Should().BeTrue();

            Resubscribe(engine, T0 + 180_000);
            var third = worker.WhenNextAttemptEnds(InstrumentRoot.MES);
            worker.Schedule(engine);
            var done = await third.WaitAsync(TimeSpan.FromSeconds(5));
            await worker.WhenIdle(InstrumentRoot.MES);

            done.Completed.Should().BeTrue();
            calls.Should().Be(3);
            worker.LiveSlots.Should().Be(0);
            engine.Status().Code.Should().Be("DEGRADED");
            engine.Summary().Last.Should().Be(Px);
        }
        finally
        {
            await worker.StopAsync();
            worker.Dispose();
        }
    }

    private static void Prime(InstrumentEngine engine, InstrumentSpec? spec = null)
    {
        spec ??= InstrumentCatalog.MES;
        engine.Apply(TestData.Status(T0, connected: true) with { Root = spec.Root, ContractId = spec.ContractId });
        engine.Apply(TestData.Snapshot(T0) with { Root = spec.Root, ContractId = spec.ContractId });
        engine.Apply(TestData.Trade(T0 + 1_000, Px, 1, BookSide.Bid, $"seed-{spec.Root}") with
        {
            Root = spec.Root,
            ContractId = spec.ContractId,
        });
        engine.Tick(T0 + 300_000);
        engine.Apply(TestData.Status(T0 + 300_000, connected: true) with { Root = spec.Root, ContractId = spec.ContractId });
    }

    private static void Resubscribe(InstrumentEngine engine, long timeMs, InstrumentSpec? spec = null)
    {
        spec ??= InstrumentCatalog.MES;
        engine.Apply(new BookResetEvent
        {
            Root = spec.Root,
            ContractId = spec.ContractId,
            SourceTimeMs = timeMs,
            ReceivedTimeMs = timeMs,
            Epoch = 2,
            Sequence = 1,
            Reason = BookResetEvent.SubscribedReason,
        });
        engine.Apply(TestData.Snapshot(timeMs) with
        {
            Root = spec.Root,
            ContractId = spec.ContractId,
            Resubscribe = true,
            GatewayTimeMs = timeMs,
            Epoch = 2,
        });
    }

    private static HistoricalMinuteBar Bar(long startMs, long volume) =>
        new(startMs, Px - 1, Px + 2, Px - 2, Px + 1, volume);

    private sealed class ScriptedBars(
        Func<InstrumentSpec, long, long, CancellationToken, Task<IReadOnlyList<HistoricalMinuteBar>>> next) : IMinuteBarSource
    {
        public Task<IReadOnlyList<HistoricalMinuteBar>> GetClosedMinuteBarsAsync(
            InstrumentSpec instrument,
            long fromMs,
            long toMs,
            CancellationToken cancellationToken) =>
            next(instrument, fromMs, toMs, cancellationToken);
    }

    private sealed class CollectingLogger : ILogger
    {
        public List<string> Lines { get; } = [];

        public IDisposable BeginScope<TState>(TState state) where TState : notnull => Empty.Instance;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Lines.Add(formatter(state, exception));

        private sealed class Empty : IDisposable
        {
            public static readonly Empty Instance = new();

            public void Dispose()
            {
            }
        }
    }

    /// <summary>Completes a wait when the test advances, so a retry never sleeps.</summary>
    private sealed class AdvanceableDelay
    {
        private readonly List<(long Due, TaskCompletionSource Done)> _pending = [];
        private long _now;

        public TimeSpan? Pending
        {
            get
            {
                lock (_pending)
                {
                    return _pending.Count == 0 ? null : TimeSpan.FromMilliseconds(_pending[0].Due - _now);
                }
            }
        }

        public Task Wait(TimeSpan delay, CancellationToken cancellationToken)
        {
            var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_pending)
            {
                _pending.Add((_now + (long)delay.TotalMilliseconds, done));
            }

            cancellationToken.Register(() => done.TrySetCanceled(cancellationToken));
            return done.Task;
        }

        /// <summary>Waits until a delay of <paramref name="expected"/> is armed, so <see cref="Advance"/> cannot miss it.</summary>
        public async Task UntilPending(TimeSpan expected)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (Pending != expected)
            {
                await Task.Delay(1, timeout.Token);
            }
        }

        public void Advance(TimeSpan by)
        {
            List<TaskCompletionSource> ready;
            lock (_pending)
            {
                _now += (long)by.TotalMilliseconds;
                ready = _pending.Where(item => item.Due <= _now).Select(item => item.Done).ToList();
                _pending.RemoveAll(item => item.Due <= _now);
            }

            foreach (var done in ready)
            {
                done.TrySetResult();
            }
        }
    }
}
