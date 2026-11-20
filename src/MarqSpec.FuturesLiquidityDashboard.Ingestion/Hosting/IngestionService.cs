using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.Profile;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

/// <summary>
/// Drives the engines from the configured feed (ARCHITECTURE.md D-11): resolves the contracts the feed streams,
/// loads warmup history, then applies every streamed event to its instrument's engine and ticks the engines'
/// clocks. A failed stream is restarted with backoff; while it is down every engine shows DISCONNECTED and its
/// book as unknown, never the last book (REQUIREMENTS.md FR-7). A refused login or a bad feed setting fails the same way
/// every time, so it stops the service instead: no retry, no repeated logins.
/// </summary>
public sealed partial class IngestionService(
    IMarketDataFeed feed,
    EngineRegistry registry,
    IOptions<FeedOptions> options,
    ExchangeCalendar calendar,
    IngestionState state,
    TimeProvider time,
    ILogger<IngestionService> logger,
    IHistoricalTradeSource? history = null,
    IInstrumentResolver? resolver = null,
    InstrumentSelection? selection = null,
    IMinuteBarSource? minutes = null,
    int repairMaxOpenHoleAttempts = GapRepairWorker.DefaultMaxOpenHoleAttempts,
    IConfiguration? configuration = null,
    IngestMetrics? metrics = null) : BackgroundService
{
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(30);

    // Clock drift refuses every event, so it is logged at most once a minute per instrument, with the count since the last line.
    private readonly CounterLogThrottle _clockAheadLog = new(TimeSpan.FromMinutes(1));
    private readonly CounterLogThrottle _lateSignalLog = new(TimeSpan.FromMinutes(1));
    private readonly Dictionary<InstrumentRoot, long> _lateSignalsMetered = [];

    private readonly Dictionary<(InstrumentRoot Root, string Window), long> _loggedMissingDrops = [];
    private readonly GapRepairWorker? _repair = minutes is null
        ? null
        : new GapRepairWorker(minutes, registry, time, logger, maxOpenHoleAttempts: repairMaxOpenHoleAttempts);

    /// <summary>Completes when this contract's next repair attempt finishes. Tests wait on this instead of sleeping.</summary>
    public Task<GapRepairResult> WhenNextRepairEnds(InstrumentRoot root) =>
        _repair?.WhenNextAttemptEnds(root) ?? Task.FromResult(new GapRepairResult(true, 0));

    /// <summary>Completes when this contract's repair task has exited, so the next wait is not left on a removed slot.</summary>
    public Task WhenRepairIdle(InstrumentRoot root) => _repair?.WhenIdle(root) ?? Task.CompletedTask;

    // The unauthenticated readiness endpoint shows this; the upstream exception goes to the log only (§7, §11).
    internal const string FailedDescription = "The market-data feed failed and is restarting; see the API logs.";

    // Shown when retrying cannot help. Like FailedDescription it names no credential and no upstream detail.
    internal const string StoppedDescription =
        "The market-data feed's credentials or configuration were refused, so it stopped and will not retry. Fix them and restart; see the API logs.";

    /// <summary>A refused login or a setting the upstream does not have: retrying would fail the same way, and log in again each time.</summary>
    private static bool IsPermanent(Exception exception)
    {
        if (ProjectXLoginGuard.IsRefused(exception))
        {
            return true;
        }

        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is FeedConfigurationException)
            {
                return true;
            }
        }

        return false;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (configuration is not null)
        {
            IngestionServiceCollectionExtensions.WarnRetiredSignalRetention(configuration, logger);
        }

        try
        {
            var specs = await PrepareWithRetriesAsync(stoppingToken).ConfigureAwait(false);
            if (specs is null)
            {
                return;
            }

            var ticker = TickAsync(stoppingToken);
            try
            {
                await StreamWithRestartsAsync(specs, stoppingToken).ConfigureAwait(false);
            }
            finally
            {
                await ticker.ConfigureAwait(false);
            }
        }
        finally
        {
            if (_repair is not null)
            {
                await _repair.StopAsync().ConfigureAwait(false);
                _repair.Dispose();
            }
        }
    }

    /// <summary>
    /// Runs <see cref="PrepareAsync"/> until it succeeds, with the same backoff as the stream, so a transient upstream
    /// outage at startup leaves the API up and reporting Unhealthy instead of stopping the host. Null when stopping.
    /// </summary>
    private async Task<IReadOnlyList<InstrumentSpec>?> PrepareWithRetriesAsync(CancellationToken stoppingToken)
    {
        var backoff = TimeSpan.FromSeconds(1);
        while (true)
        {
            try
            {
                return await PrepareAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return null;
            }
            catch (Exception ex) when (ProjectXSessionGuard.IsConflict(ex))
            {
                Log.SessionConflict(logger);
                state.MarkFailed(ProjectXSessionConflictException.StopMessage);
                return null;
            }
            catch (Exception ex) when (IsPermanent(ex))
            {
                Log.FeedRefused(logger, feed.Name, ex);
                state.MarkFailed(StoppedDescription);
                return null;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                Log.PrepareFailed(logger, feed.Name, backoff, ex);
                state.MarkFailed(FailedDescription);
                try
                {
                    await Task.Delay(backoff, time, stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return null;
                }

                backoff = TimeSpan.FromTicks(Math.Min(MaxBackoff.Ticks, backoff.Ticks * 2));
            }
        }
    }

    /// <summary>
    /// Resolves contracts (and, for a selection of every product, discovers which the feed offers), replaces the
    /// engines with ones bound to them, and loads warmup history.
    /// </summary>
    internal async Task<IReadOnlyList<InstrumentSpec>> PrepareAsync(CancellationToken cancellationToken)
    {
        IReadOnlyList<InstrumentSpec> specs = registry.All.Select(e => e.Spec).ToList();
        if (resolver is not null)
        {
            var wanted = selection ?? InstrumentSelection.Of([.. specs.Select(s => s.Root)]);
            specs = await resolver.ResolveAsync(wanted, specs, cancellationToken).ConfigureAwait(false);
            registry.Replace(specs);
            Log.Resolved(logger, feed.Name, specs.Count);
        }

        if (history is not null)
        {
            var now = time.GetUtcNow();
            var (fromMs, toMs, covered) = WarmupWindow(now, options.Value, registry.Options, calendar);
            if (!covered)
            {
                Log.WarmupCapped(logger, MaxHistoryHours, registry.Options.Regime.WarmupHours, registry.Options.IndicatorWarmupMinutes);
            }

            var parallel = new ParallelOptions
            {
                MaxDegreeOfParallelism = Math.Max(1, options.Value.HistoryConcurrency),
                CancellationToken = cancellationToken,
            };
            await Parallel.ForEachAsync(specs, parallel, async (spec, ct) =>
            {
                if (!registry.TryGet(spec.Root, out var engine))
                {
                    return;
                }

                try
                {
                    var trades = await history.GetTradesAsync(spec, fromMs, toMs, ct).ConfigureAwait(false);
                    engine.LoadHistory(trades, toMs);
                    Log.HistoryLoaded(logger, spec.Root, trades.Count);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // History is warmup only: without it the indicators start empty, which the UI labels as warming.
                    Log.HistoryFailed(logger, spec.Root, ex);
                }
            }).ConfigureAwait(false);
        }

        state.MarkHistoryLoaded();
        return specs;
    }

    /// <summary>The furthest back warmup history reaches, whatever the regimes or the EMAs need (ARCHITECTURE.md D-68).</summary>
    public const double MaxHistoryHours = 24;

    /// <summary>
    /// The warmup window (ARCHITECTURE.md D-28, D-68). The current rule is <see cref="HistoryWindow"/> over
    /// <c>MinHistoryHours</c>, raised to the slowest regime's warmup when <c>WarmRegimes</c> is on. With
    /// <c>WarmRegimes</c> on it also reaches back until it holds enough open-market minutes to seed the slowest EMA on
    /// <see cref="EngineOptions.SeededIndicatorSeconds"/> bars (REQUIREMENTS.md FR-17). Never more than
    /// <see cref="MaxHistoryHours"/> back; <c>Covered</c> is false when a need did not fit.
    /// </summary>
    public static (long FromMs, long ToMs, bool Covered) WarmupWindow(
        DateTimeOffset now, FeedOptions feed, EngineOptions engine, ExchangeCalendar calendar)
    {
        ArgumentNullException.ThrowIfNull(feed);
        ArgumentNullException.ThrowIfNull(engine);
        ArgumentNullException.ThrowIfNull(calendar);
        // Far enough back for the slowest regime timeframe to be classified at startup (REQUIREMENTS.md FR-56).
        var minHours = feed.WarmRegimes ? Math.Max(feed.MinHistoryHours, engine.Regime.WarmupHours) : feed.MinHistoryHours;
        var (fromMs, toMs) = HistoryWindow(now, minHours, calendar);
        var covered = minHours <= MaxHistoryHours;
        if (feed.WarmRegimes)
        {
            var (emaFrom, emaCovered) = calendar.OpenMinutesBack(now, engine.IndicatorWarmupMinutes, now.AddHours(-MaxHistoryHours));
            fromMs = Math.Min(fromMs, emaFrom.ToUnixTimeMilliseconds());
            covered &= emaCovered;
        }

        return (fromMs, toMs, covered);
    }

    /// <summary>From the earlier of the session open and <paramref name="minHours"/> ago, capped at <see cref="MaxHistoryHours"/>, to now.</summary>
    public static (long FromMs, long ToMs) HistoryWindow(DateTimeOffset now, double minHours, ExchangeCalendar calendar)
    {
        ArgumentNullException.ThrowIfNull(calendar);
        var toMs = now.ToUnixTimeMilliseconds();
        var byHours = now.AddHours(-Math.Clamp(minHours, 0, MaxHistoryHours)).ToUnixTimeMilliseconds();
        var open = calendar.SessionFor(now).Open.ToUnixTimeMilliseconds();
        var fromMs = Math.Max(Math.Min(byHours, open), now.AddHours(-MaxHistoryHours).ToUnixTimeMilliseconds());
        return (Math.Min(fromMs, toMs), toMs);
    }

    private async Task StreamWithRestartsAsync(IReadOnlyList<InstrumentSpec> specs, CancellationToken stoppingToken)
    {
        var backoff = TimeSpan.FromSeconds(1);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                Log.Streaming(logger, feed.Name, specs.Count);
                var first = true;
                await foreach (var e in feed.StreamAsync(specs, stoppingToken).ConfigureAwait(false))
                {
                    if (first)
                    {
                        state.MarkStreaming();
                        backoff = TimeSpan.FromSeconds(1);
                        first = false;
                    }

                    if (!registry.TryGet(e.Root, out var engine))
                    {
                        continue;
                    }

                    if (e is TradeGapEvent gap)
                    {
                        // The reader only marks the hole. Closed-bar repair, when the feed has history, runs
                        // on its own task so this loop keeps draining every other contract (D-33).
                        engine.MarkMissing(gap.GapStartMs);
                        if (gap.GapThroughMs > gap.GapStartMs)
                        {
                            engine.MarkMissing(gap.GapThroughMs);
                        }

                        _repair?.Schedule(engine);
                        continue;
                    }

                    engine.Apply(e);
                    if (_repair is not null && engine.TakeRepairKick())
                    {
                        // The hole now has an end. A task that paused while the hole was open has to run again.
                        _repair.Schedule(engine);
                    }

                    NoteMissingCap(engine);
                }

                // A feed that ends without being cancelled (a replay file without Loop) leaves the last state in place.
                if (!stoppingToken.IsCancellationRequested)
                {
                    Log.Ended(logger, feed.Name);
                    await Task.Delay(Timeout.InfiniteTimeSpan, time, stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex) when (ProjectXSessionGuard.IsConflict(ex))
            {
                Log.SessionConflict(logger);
                state.MarkFailed(ProjectXSessionConflictException.StopMessage);
                MarkDisconnected(specs);
                return;
            }
            catch (Exception ex) when (IsPermanent(ex))
            {
                Log.FeedRefused(logger, feed.Name, ex);
                state.MarkFailed(StoppedDescription);
                MarkDisconnected(specs);
                return;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                Log.StreamFailed(logger, feed.Name, backoff, ex);
                state.MarkFailed(FailedDescription);
                MarkDisconnected(specs);
                try
                {
                    await Task.Delay(backoff, time, stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }

                backoff = TimeSpan.FromTicks(Math.Min(MaxBackoff.Ticks, backoff.Ticks * 2));
            }
        }
    }

    private void MarkDisconnected(IReadOnlyList<InstrumentSpec> specs)
    {
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        foreach (var spec in specs)
        {
            if (registry.TryGet(spec.Root, out var engine))
            {
                engine.Apply(new FeedStatusEvent
                {
                    Root = spec.Root,
                    ContractId = spec.ContractId,
                    SourceTimeMs = now,
                    ReceivedTimeMs = now,
                    Epoch = 0,
                    Sequence = 0,
                    Connected = false,
                    Provenance = feed.Provenance,
                });
            }
        }
    }

    private void NoteMissingCap(InstrumentEngine engine)
    {
        var root = engine.Spec.Root;
        foreach (var (window, dropped) in engine.MissingRangesDropped)
        {
            var key = (root, window);
            var seen = _loggedMissingDrops.GetValueOrDefault(key);
            if (dropped <= seen)
            {
                continue;
            }

            Log.MissingRangesCapped(logger, root, window, dropped - seen, VolumeProfile.MaxClosedRanges);
            _loggedMissingDrops[key] = dropped;
        }
    }

    private void NoteLateSignals(InstrumentEngine engine, long nowMs)
    {
        var total = engine.LateSignalsDropped;
        var root = engine.Spec.Root;
        var metered = _lateSignalsMetered.GetValueOrDefault(root);
        if (total > metered)
        {
            metrics?.AddDroppedLateSignals(total - metered);
            _lateSignalsMetered[root] = total;
        }

        if (_lateSignalLog.Take(root, total, nowMs) is { } count)
        {
            Log.LateSignalsDropped(logger, count, root, total);
        }
    }

    private void NoteClockAhead(InstrumentEngine engine, long nowMs)
    {
        var total = engine.ClockAheadRejectedEvents;
        if (_clockAheadLog.Take(engine.Spec.Root, total, nowMs) is { } count)
        {
            Log.ClockAheadRejected(logger, count, engine.Spec.Root, InstrumentEngine.MaxClockAheadMs / 1000, total);
        }
    }

    private async Task TickAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(options.Value.TickMs), time);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                var now = time.GetUtcNow().ToUnixTimeMilliseconds();
                foreach (var engine in registry.All)
                {
                    engine.Tick(now);
                    NoteClockAhead(engine, now);
                    NoteLateSignals(engine, now);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Information, Message = "Loaded {Count} warmup trades for {Root}")]
        public static partial void HistoryLoaded(ILogger logger, InstrumentRoot root, int count);

        [LoggerMessage(Level = LogLevel.Information, Message = "Warmup history is capped at {CapHours} h, short of the regime warmup ({RegimeHours} h) or the {EmaMinutes} open-market minutes the five-minute EMAs need; what it cannot seed shows as warming up until live bars arrive")]
        public static partial void WarmupCapped(ILogger logger, double capHours, double regimeHours, int emaMinutes);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Warmup history for {Root} failed; indicators start empty")]
        public static partial void HistoryFailed(ILogger logger, InstrumentRoot root, Exception exception);

        [LoggerMessage(Level = LogLevel.Information, Message = "Feed {Feed} resolved {Count} instruments")]
        public static partial void Resolved(ILogger logger, string feed, int count);

        [LoggerMessage(Level = LogLevel.Information, Message = "Streaming {Feed} for {Count} instruments")]
        public static partial void Streaming(ILogger logger, string feed, int count);

        [LoggerMessage(Level = LogLevel.Information, Message = "Feed {Feed} ended")]
        public static partial void Ended(ILogger logger, string feed);

        [LoggerMessage(Level = LogLevel.Error, Message = "Preparing feed {Feed} (contracts, history) failed; retrying in {Backoff}")]
        public static partial void PrepareFailed(ILogger logger, string feed, TimeSpan backoff, Exception exception);

        [LoggerMessage(Level = LogLevel.Error, Message = "Feed {Feed} failed; restarting in {Backoff}")]
        public static partial void StreamFailed(ILogger logger, string feed, TimeSpan backoff, Exception exception);

        [LoggerMessage(Level = LogLevel.Error, Message = "TopstepX reported a session conflict. Not reconnecting.")]
        public static partial void SessionConflict(ILogger logger);

        [LoggerMessage(Level = LogLevel.Critical, Message = "Feed {Feed} stopped: the upstream refused its credentials or configuration. Not retrying; fix them and restart")]
        public static partial void FeedRefused(ILogger logger, string feed, Exception exception);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Refused {Count} {Root} events stamped more than {AheadSeconds} s after they were received; check the host clock and the feed's timestamps ({Total} since start)")]
        public static partial void ClockAheadRejected(ILogger logger, long count, InstrumentRoot root, long aheadSeconds, long total);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Dropped {Count} {Root} order-flow signals stamped behind the newest one kept; the prints were still applied ({Total} since start)")]
        public static partial void LateSignalsDropped(ILogger logger, long count, InstrumentRoot root, long total);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Dropped {Count} old missing ranges for {Root} {Window}; keeping the newest {Kept}")]
        public static partial void MissingRangesCapped(ILogger logger, InstrumentRoot root, string window, long count, int kept);

    }
}
