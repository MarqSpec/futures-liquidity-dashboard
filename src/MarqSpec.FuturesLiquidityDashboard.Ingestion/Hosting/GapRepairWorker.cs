using System.Collections.Concurrent;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using Microsoft.Extensions.Logging;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

/// <summary>
/// Fills dropped-trade holes from closed one-minute bars, one task per contract, off the feed reader.
/// A contract's retry never blocks another contract. Completion waits until the closed bar covering the
/// hole's end is returned; a non-zero write is not enough. An open hole, which has no end bar, stops after
/// <see cref="DefaultMaxOpenHoleAttempts"/> and stays DEGRADED. A finished or paused slot is removed
/// (ARCHITECTURE.md D-33).
/// </summary>
public sealed partial class GapRepairWorker : IDisposable
{
    /// <summary>How many reads an open hole gets before the task pauses. Closing the hole schedules another.</summary>
    public const int DefaultMaxOpenHoleAttempts = 4;
    private readonly IMinuteBarSource _source;
    private readonly EngineRegistry _registry;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<InstrumentRoot, Slot> _slots = new();
    private readonly ConcurrentDictionary<InstrumentRoot, Mailbox> _mailboxes = new();
    private readonly int _initialMs;
    private readonly int _maxMs;
    private readonly int _maxOpenHoleAttempts;

    public GapRepairWorker(
        IMinuteBarSource source,
        EngineRegistry registry,
        TimeProvider time,
        ILogger logger,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        int initialBackoffMs = 1_000,
        int maxBackoffMs = 30_000,
        int maxOpenHoleAttempts = DefaultMaxOpenHoleAttempts)
    {
        _source = source ?? throw new ArgumentNullException(nameof(source));
        _registry = registry ?? throw new ArgumentNullException(nameof(registry));
        _time = time ?? throw new ArgumentNullException(nameof(time));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _delay = delay ?? ((span, token) => Task.Delay(span, time, token));
        _initialMs = Math.Max(1, initialBackoffMs);
        _maxMs = Math.Max(_initialMs, maxBackoffMs);
        _maxOpenHoleAttempts = Math.Max(1, maxOpenHoleAttempts);
    }

    /// <summary>Contracts that still hold a repair task. Idle slots are removed.</summary>
    public int LiveSlots => _slots.Count;

    /// <summary>Arms the engine and starts its repair if one is not already running. Returns immediately.</summary>
    public void Schedule(InstrumentEngine engine)
    {
        ArgumentNullException.ThrowIfNull(engine);
        ObjectDisposedException.ThrowIf(_stop.IsCancellationRequested, this);
        engine.ArmGapRepair();
        _slots.GetOrAdd(engine.Spec.Root, static (root, worker) => new Slot(root, worker), this).Poke();
    }

    /// <summary>Completes when this contract's next repair attempt finishes. Tests wait on this instead of sleeping.</summary>
    public Task<GapRepairResult> WhenNextAttemptEnds(InstrumentRoot root) =>
        _mailboxes.GetOrAdd(root, static _ => new Mailbox()).Wait();

    /// <summary>Completes when this contract's repair task has exited, including the removal of an idle slot.</summary>
    public Task WhenIdle(InstrumentRoot root) =>
        _slots.TryGetValue(root, out var slot) ? slot.Running ?? Task.CompletedTask : Task.CompletedTask;

    public void Dispose() => _stop.Dispose();

    public async Task StopAsync()
    {
        await _stop.CancelAsync().ConfigureAwait(false);
        var running = new List<Task>();
        foreach (var slot in _slots.Values)
        {
            if (slot.Running is { } task)
            {
                running.Add(task);
            }
        }

        try
        {
            await Task.WhenAll(running).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // The delay or the history read observed the stop.
        }
    }

    /// <summary>
    /// The latest unconsumed attempt results for one contract. The repair task is removed when it goes idle;
    /// this keeps a result a test asks for after that, and it does not grow with repeated attempts.
    /// </summary>
    private sealed class Mailbox
    {
        private readonly Queue<GapRepairResult> _queued = new();
        private TaskCompletionSource<GapRepairResult>? _waiter;

        public Task<GapRepairResult> Wait()
        {
            lock (this)
            {
                if (_queued.Count > 0)
                {
                    var ready = new TaskCompletionSource<GapRepairResult>(TaskCreationOptions.RunContinuationsAsynchronously);
                    ready.TrySetResult(_queued.Dequeue());
                    return ready.Task;
                }

                _waiter ??= new TaskCompletionSource<GapRepairResult>(TaskCreationOptions.RunContinuationsAsynchronously);
                return _waiter.Task;
            }
        }

        public void Post(GapRepairResult result)
        {
            TaskCompletionSource<GapRepairResult>? waiter;
            lock (this)
            {
                waiter = _waiter;
                _waiter = null;
                if (waiter is null)
                {
                    _queued.Enqueue(result);
                    while (_queued.Count > 4)
                    {
                        _queued.Dequeue();
                    }
                }
            }

            waiter?.TrySetResult(result);
        }
    }

    private sealed class Slot(InstrumentRoot root, GapRepairWorker worker)
    {
        private int _running;
        private int _dirty;
        private Task? _task;

        public Task? Running => _task;

        public void Poke()
        {
            Interlocked.Exchange(ref _dirty, 1);
            if (Interlocked.CompareExchange(ref _running, 1, 0) != 0)
            {
                return;
            }

            _task = Task.Run(Loop);
        }

        private async Task Loop()
        {
            var backoff = TimeSpan.FromMilliseconds(worker._initialMs);
            var openAttempts = 0;
            var stopping = worker._stop.Token;
            try
            {
                while (!stopping.IsCancellationRequested)
                {
                    Interlocked.Exchange(ref _dirty, 0);
                    GapRepairResult result;
                    try
                    {
                        result = await Attempt(stopping).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (stopping.IsCancellationRequested)
                    {
                        return;
                    }
                    catch (Exception ex) when (ex is not OutOfMemoryException)
                    {
                        Log.Failed(worker._logger, root, ex);
                        result = new GapRepairResult(false, 0);
                    }

                    Signal(result);
                    if (result.Completed && Volatile.Read(ref _dirty) == 0)
                    {
                        return;
                    }

                    // A gap that arrived during the read is new work, so it does not spend the open-hole budget.
                    if (Volatile.Read(ref _dirty) == 1)
                    {
                        openAttempts = 0;
                        backoff = TimeSpan.FromMilliseconds(worker._initialMs);
                        continue;
                    }

                    // An open hole has no end bar to wait for. Counting those quiet reads stops the task from
                    // polling for the life of the process. The contract stays DEGRADED; closing the hole
                    // schedules another attempt (D-33).
                    if (!result.Completed && AwaitsEndBar())
                    {
                        openAttempts++;
                        if (openAttempts >= worker._maxOpenHoleAttempts)
                        {
                            Log.Paused(worker._logger, root, openAttempts);
                            return;
                        }
                    }
                    else
                    {
                        openAttempts = 0;
                    }

                    await worker._delay(backoff, stopping).ConfigureAwait(false);
                    var grown = Math.Min(worker._maxMs, backoff.TotalMilliseconds * 2);
                    backoff = TimeSpan.FromMilliseconds(grown);
                }
            }
            finally
            {
                Interlocked.Exchange(ref _running, 0);
                if (Volatile.Read(ref _dirty) == 1
                    && !stopping.IsCancellationRequested
                    && Interlocked.CompareExchange(ref _running, 1, 0) == 0)
                {
                    _task = Task.Run(Loop);
                }
                else if (Volatile.Read(ref _running) == 0)
                {
                    worker._slots.TryRemove(new KeyValuePair<InstrumentRoot, Slot>(root, this));
                }
            }
        }

        private bool AwaitsEndBar() =>
            worker._registry.TryGet(root, out var engine) && engine.RepairAwaitsEndBar();

        private async Task<GapRepairResult> Attempt(CancellationToken stopping)
        {
            if (!worker._registry.TryGet(root, out var engine))
            {
                return new GapRepairResult(true, 0);
            }

            var window = engine.NextRepairWindow(worker._time.GetUtcNow().ToUnixTimeMilliseconds());
            if (!window.Pending)
            {
                engine.NoteRepairSettled();
                return new GapRepairResult(true, 0);
            }

            var bars = await worker._source.GetClosedMinuteBarsAsync(engine.Spec, window.FromMs, window.ToMs, stopping)
                .ConfigureAwait(false);
            var result = engine.ApplyApproximateMinutes(bars);
            Log.Attempt(worker._logger, root, result.MinutesWritten, result.Completed);
            return result;
        }

        private void Signal(GapRepairResult result) =>
            worker._mailboxes.GetOrAdd(root, static _ => new Mailbox()).Post(result);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Information, Message = "Approximate gap repair for {Root} wrote {Minutes} minute(s); completed {Completed}")]
        public static partial void Attempt(ILogger logger, InstrumentRoot root, int minutes, bool completed);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Approximate gap repair for {Root} failed and will retry")]
        public static partial void Failed(ILogger logger, InstrumentRoot root, Exception exception);

        [LoggerMessage(
            Level = LogLevel.Warning,
            Message = "Approximate gap repair for {Root} paused after {Attempts} attempts because the hole has no end bar. The repair is not complete and the contract stays DEGRADED")]
        public static partial void Paused(ILogger logger, InstrumentRoot root, int attempts);
    }
}
