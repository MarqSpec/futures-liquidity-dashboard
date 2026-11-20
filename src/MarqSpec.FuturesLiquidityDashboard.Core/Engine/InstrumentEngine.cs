using MarqSpec.FuturesLiquidityDashboard.Core.Bars;
using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Heatmap;
using MarqSpec.FuturesLiquidityDashboard.Core.Indicators;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Levels;
using MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;
using MarqSpec.FuturesLiquidityDashboard.Core.Plans;
using MarqSpec.FuturesLiquidityDashboard.Core.Profile;
using MarqSpec.FuturesLiquidityDashboard.Core.Regime;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Engine;

/// <summary>
/// The whole per-instrument state of ARCHITECTURE.md (book, slice integrals, trade bars, indicators, profiles,
/// liquidity metrics, status) for one contract. Instruments never share an engine (REQUIREMENTS.md P4). Every public member
/// takes the engine's lock, so one ingestion loop and many readers can use it at once; nothing here does I/O.
/// </summary>
public sealed class InstrumentEngine
{
    private const int MinuteMs = 60_000;

    /// <summary>How far an event's source time may run ahead of its receive time (clock skew) before it is rejected.</summary>
    public const long MaxClockAheadMs = 60_000;
    private static readonly int[] DepthLevels = [1, 5, 10];

    private readonly Lock _gate = new();
    private readonly EngineOptions _options;
    private readonly ExchangeCalendar _calendar;
    private readonly OrderBook _book = new();
    private readonly SliceIntegrator _integrator;
    private readonly BarAggregator _secondBars;
    private readonly BarAggregator _minuteBars = new(MinuteMs);
    /// <summary>
    /// Indicator state for the layout's 1, 5 and 15 minute choices (REQUIREMENTS.md FR-2). One publication carries all three
    /// so a viewer's timeframe does not retune the engine every other viewer reads.
    /// </summary>
    private readonly IndicatorEngine[] _indicatorEngines;

    /// <summary>The one-minute set the agent context reads (ARCHITECTURE.md D-13). Also the first viewer set.</summary>
    private readonly IndicatorEngine _oneMinuteIndicators;
    private readonly SessionVwap _vwap = new();
    private readonly VolumeProfile _sessionProfile = VolumeProfile.Session();
    private readonly VolumeProfile _profile1h = VolumeProfile.Rolling(TimeSpan.FromHours(1), "1h");
    private readonly VolumeProfile _profile4h = VolumeProfile.Rolling(TimeSpan.FromHours(4), "4h");
    private readonly VolumeProfile _profile5d = VolumeProfile.Rolling(TimeSpan.FromDays(5), "5d");
    private readonly LiquidityFlowTracker _flows = new();
    private readonly WallDetector _walls = new();
    private readonly TradeDeduplicator _dedup = new();
    private readonly OrderFlowAnalyzer _orderFlow;
    private readonly List<HeatmapColumn> _heat = [];
    private readonly List<HeatmapColumn> _minuteHeat = [];
    private readonly List<HeatmapColumn> _openMinuteHeat = [];
    private readonly List<TradeBar> _bars = [];
    private readonly List<TradeBar> _closedMinutes = [];
    private readonly Queue<(long TimeMs, long Quantity, long Delta)> _recentTrades = new();
    private readonly TapeActivity _tape;

    private FeedProvenance _provenance = FeedProvenance.Simulated;
    private bool _connected;
    private bool _depthSubscribed = true;
    private long? _quoteBid;
    private long? _quoteAsk;
    private long? _topOfBookMs;
    private long? _topReceivedMs;
    private long? _lastTradeMs;
    private int _watchers;
    private long _epoch;
    private long _lastReceivedMs = long.MinValue;
    private long _lastMarketMs = long.MinValue;
    private long _nowMs;
    private string? _sessionId;
    private long _cumulativeDelta;
    private long _sessionVolume;
    private long? _sessionOpen;
    private long? _sessionHigh;
    private long? _sessionLow;
    private long? _lastPrice;
    private long? _historyWatermarkMs;
    private long? _missingSinceMs;

    /// <summary>Latest dropped-trade time the open hole must still cover (D-32).</summary>
    private long _missingThroughMs;
    private readonly Dictionary<string, long> _missingRangesDropped = [];
    private long _gapEpoch;
    private bool _resubscribeAfterGap;
    private bool _cvdKnown = true;
    private bool _repairArmed;
    private bool _repairKick;
    private readonly List<GapSpan> _gaps = [];
    private readonly HashSet<long> _repairedMinutes = [];
    private readonly List<(long StartMs, long EndMs)> _retiredRepairs = [];
    private long _retiredRepairFloorMs = long.MinValue;
    private readonly HashSet<long> _republishMinutes = [];
    private readonly HashSet<long> _republishFootprints = [];
    private long? _collectionStartMs;
    private long _seq;
    private long _publishedHeatMs = long.MinValue;
    private long _publishedBarMs = long.MinValue;
    private long _publishedMinuteHeatMs = long.MinValue;
    private long _publishedMinuteBarMs = long.MinValue;
    private long _openMinuteStart = long.MinValue;
    private long _publishedIndicatorMs = long.MinValue;
    private long _publishedFootprintMs = long.MinValue;
    private long _publishedRangeZoneVersion;
    private long _publishedSignalId;
    private readonly List<RegimeTracker> _regimes;
    private long _rejected;
    private long _rejectedClockAhead;
    private long _resets;
    private readonly List<PrintDto> _prints = [];
    private readonly RipsLedger _rips = new();

    /// <summary>Ask minus bid volume at each price this session; footprints are trimmed, this is not (REQUIREMENTS.md FR-73).</summary>
    private readonly Dictionary<long, long> _sessionDelta = [];
    private long _printSequence;
    private long _publishedPrintSequence;
    private long _printsEpoch;

    public InstrumentEngine(InstrumentSpec spec, EngineOptions? options = null, ExchangeCalendar? calendar = null)
    {
        Spec = spec ?? throw new ArgumentNullException(nameof(spec));
        _options = options ?? EngineOptions.Default;
        _calendar = calendar ?? new ExchangeCalendar();
        _integrator = new SliceIntegrator(_options.SliceMs);
        _secondBars = new BarAggregator(_options.SliceMs);
        _oneMinuteIndicators = new IndicatorEngine(AtTimeframe(_options.Indicators, 60));
        _indicatorEngines =
        [
            _oneMinuteIndicators,
            new IndicatorEngine(AtTimeframe(_options.Indicators, 300)),
            new IndicatorEngine(AtTimeframe(_options.Indicators, 900)),
        ];
        _regimes = _options.Regime.TimeframesSeconds.Distinct().Order().Select(tf => new RegimeTracker(tf, _options.Regime)).ToList();
        _tape = new TapeActivity(_options.Tape);
        _orderFlow = new OrderFlowAnalyzer(
            _options.OrderFlow,
            TpoRowTicks(spec, _options.OrderFlow.TpoRowTicks),
            Math.Max(0, _options.HistoryRetentionMinutes) * (long)MinuteMs)
        {
            ExternalLevels = ExternalLevels,
            NamedLevels = RipsLevelsLocked,
        };
        _orderFlow.Signals.ThinTape = () => TapeLocked().State == TapeState.Thin;
    }

    /// <summary>
    /// TPO row height: configured, else the contract's round increment (MES 1.00, MGC 1.0, MCL 0.05, and the same
    /// increments on ES, GC and CL), else four ticks for a product the catalog does not describe.
    /// </summary>
    public static int TpoRowTicks(InstrumentSpec spec, int configured)
    {
        ArgumentNullException.ThrowIfNull(spec);
        return configured > 0 ? configured : spec.TpoRowTicks > 0 ? spec.TpoRowTicks : 4;
    }

    public InstrumentSpec Spec { get; }

    public InstrumentInfo Info => new(Spec.Root.ToString(), Spec.Name, Spec.Exchange, Spec.ContractId, Spec.Expiry,
        Spec.TickSize, Spec.TickValue, Spec.PriceDecimals, Spec.Sector);

    /// <summary>
    /// Events refused because they were for another contract, carried an invalid price, or were stamped more than
    /// <see cref="MaxClockAheadMs"/> after they were received (REQUIREMENTS.md FR-5).
    /// </summary>
    public long RejectedEvents
    {
        get
        {
            lock (_gate)
            {
                return _rejected;
            }
        }
    }

    /// <summary>
    /// The part of <see cref="RejectedEvents"/> refused for a source time more than <see cref="MaxClockAheadMs"/> after
    /// it was received: a host or upstream clock problem, not a bad event, so it is counted on its own (REQUIREMENTS.md FR-5).
    /// </summary>
    public long ClockAheadRejectedEvents
    {
        get
        {
            lock (_gate)
            {
                return _rejectedClockAhead;
            }
        }
    }

    /// <summary>
    /// Order-flow signals not stored because their time was strictly before the newest signal already kept.
    /// The print is still applied. The ingestion service logs the growth at most once a minute (REQUIREMENTS.md FR-69, D-41).
    /// </summary>
    public long LateSignalsDropped
    {
        get
        {
            lock (_gate)
            {
                return _orderFlow.Signals.LateDropped;
            }
        }
    }

    /// <summary>
    /// Replays historical executions to warm indicators, VWAP and profiles before live collection (REQUIREMENTS.md FR-17,
    /// FR-25). Depth is never backfilled: slices before collection stay unknown. Live trades at or before the last
    /// history trade are dropped by watermark, so nothing is counted twice.
    /// </summary>
    public void LoadHistory(IEnumerable<TradeEvent> trades, long collectionStartMs)
    {
        ArgumentNullException.ThrowIfNull(trades);
        lock (_gate)
        {
            _collectionStartMs = collectionStartMs;
            long? first = null;
            foreach (var trade in trades.OrderBy(t => t.SourceTimeMs))
            {
                if (!Accept(trade) || !_dedup.Accept(trade.TradeId))
                {
                    continue;
                }

                first ??= trade.SourceTimeMs;
                ApplyTrade(trade, live: false, displayed: null);
                _historyWatermarkMs = trade.SourceTimeMs;
            }

            var session = _calendar.SessionFor(DateTimeOffset.FromUnixTimeMilliseconds(collectionStartMs));
            var openMs = session.Open.ToUnixTimeMilliseconds();
            var coveredFrom = first ?? collectionStartMs;
            if (coveredFrom > openMs && _sessionId == session.Id)
            {
                _sessionProfile.MarkPartialSince(coveredFrom);
            }
            else if (_sessionId != session.Id)
            {
                StartSession(session.Id, openMs, collectionStartMs > openMs ? collectionStartMs : null);
            }
        }
    }

    /// <summary>Closed holes dropped per profile window because it already held <see cref="VolumeProfile.MaxClosedRanges"/> (D-32).</summary>
    public IReadOnlyDictionary<string, long> MissingRangesDropped
    {
        get
        {
            lock (_gate)
            {
                return new Dictionary<string, long>(_missingRangesDropped);
            }
        }
    }

    /// <summary>
    /// Trades were dropped. The contract is DEGRADED from <paramref name="sinceMs"/> (the exchange time of the
    /// first drop) and is not shown as LIVE. A later drop keeps the earlier time. A drop that overlaps an earlier
    /// hole merges with it. CVD is reset once per open hole because the gap has no aggressor (D-32, D-33).
    /// </summary>
    public void MarkMissing(long sinceMs)
    {
        lock (_gate)
        {
            OpenOrMerge(sinceMs);
        }
    }

    /// <summary>
    /// The feed can fill this contract from closed minute bars. Until that repair settles, the status stays
    /// DEGRADED even after the open-gap chip clears (D-33). A feed with no minute-bar source never calls this.
    /// </summary>
    public void ArmGapRepair()
    {
        lock (_gate)
        {
            _repairArmed = true;
        }
    }

    /// <summary>The exchange-time window a repair should request. Pending is false when every hole is settled.</summary>
    public GapRepairWindow NextRepairWindow(long nowMs)
    {
        lock (_gate)
        {
            long? from = null;
            var to = long.MinValue;
            var pending = false;
            foreach (var span in _gaps)
            {
                if (span.Complete)
                {
                    continue;
                }

                pending = true;
                var start = FloorMinute(span.SinceMs);
                from = from is { } had ? Math.Min(had, start) : start;
                var end = span.UntilMs ?? nowMs;
                var cover = FloorMinute(Math.Max(end - 1, span.SinceMs));
                to = Math.Max(to, cover + MinuteMs);
            }

            return pending && from is { } origin
                ? new GapRepairWindow(true, origin, Math.Max(to, origin + MinuteMs))
                : new GapRepairWindow(false, 0, 0);
        }
    }

    /// <summary>
    /// True when an incomplete hole has no end, so no closed bar can cover it yet. The repair task stops polling
    /// after a cap and stays DEGRADED until the hole closes (D-33).
    /// </summary>
    public bool RepairAwaitsEndBar()
    {
        lock (_gate)
        {
            foreach (var span in _gaps)
            {
                if (!span.Complete && span.UntilMs is null)
                {
                    return true;
                }
            }

            return false;
        }
    }

    /// <summary>
    /// True once, after a hole gains an end. The caller schedules another repair. A session roll that drops the
    /// hole clears this before the caller sees it.
    /// </summary>
    public bool TakeRepairKick()
    {
        lock (_gate)
        {
            if (!_repairKick)
            {
                return false;
            }

            _repairKick = false;
            return true;
        }
    }

    /// <summary>
    /// Writes closed minute bars into the gap minutes they belong to. A minute that already holds a live print,
    /// or that reaches the live-resume exchange time, is not written: that would double-count. The forward
    /// aggregators and <c>_lastPrice</c> / <c>_lastTradeMs</c> are not touched. Completed is true only when every
    /// open hole has an end and the response included the closed bar covering that end (D-33).
    /// </summary>
    public GapRepairResult ApplyApproximateMinutes(IReadOnlyList<HistoricalMinuteBar> bars)
    {
        ArgumentNullException.ThrowIfNull(bars);
        lock (_gate)
        {
            var byStart = new Dictionary<long, HistoricalMinuteBar>();
            foreach (var bar in bars)
            {
                if (bar.Volume < 0 || bar.HighTicks < bar.LowTicks)
                {
                    continue;
                }

                var start = FloorMinute(bar.StartMs);
                byStart.TryAdd(start, bar);
            }

            var written = 0;
            foreach (var span in _gaps)
            {
                if (span.Complete)
                {
                    continue;
                }

                written += WriteSpan(span, byStart);
                if (span.UntilMs is { } until && byStart.ContainsKey(FloorMinute(until - 1)))
                {
                    span.Complete = true;
                    NoteApproximate(span.SinceMs, until);
                }
            }

            TrimCompletedGaps();
            var pending = false;
            foreach (var span in _gaps)
            {
                if (!span.Complete)
                {
                    pending = true;
                    break;
                }
            }

            _repairArmed = pending;
            var completed = _gaps.Count > 0 && !pending;
            return new GapRepairResult(completed, written);
        }
    }

    private void OpenOrMerge(long sinceMs)
    {
        var open = OpenSpan();
        if (open is not null)
        {
            if (sinceMs < open.SinceMs)
            {
                open.SinceMs = sinceMs;
                _missingSinceMs = sinceMs;
                NoteMissing(sinceMs);
            }

            if (sinceMs > _missingThroughMs)
            {
                _missingThroughMs = sinceMs;
            }

            return;
        }

        GapSpan? merge = null;
        foreach (var span in _gaps)
        {
            if (Touches(span, sinceMs))
            {
                merge = span;
                break;
            }
        }

        if (merge is null)
        {
            _gaps.Add(new GapSpan { SinceMs = sinceMs });
        }
        else
        {
            var absorbUntil = merge.UntilMs ?? long.MaxValue;
            merge.SinceMs = Math.Min(merge.SinceMs, sinceMs);
            merge.UntilMs = null;
            merge.Complete = false;
            AbsorbOverlaps(merge, absorbUntil);
        }

        _missingSinceMs = OpenSpan()?.SinceMs ?? sinceMs;
        if (sinceMs > _missingThroughMs)
        {
            _missingThroughMs = sinceMs;
        }

        _gapEpoch = _epoch;
        _resubscribeAfterGap = false;
        _cvdKnown = false;
        _orderFlow.ResetCvdAnchor();
        _cumulativeDelta = 0;
        NoteMissing(_missingSinceMs.Value);
    }

    private GapSpan? OpenSpan()
    {
        foreach (var span in _gaps)
        {
            if (span.UntilMs is null)
            {
                return span;
            }
        }

        return null;
    }

    /// <summary>The new start lies inside the span or on its end. An earlier start does not swallow a later hole.</summary>
    private static bool Touches(GapSpan span, long sinceMs)
    {
        var end = span.UntilMs ?? long.MaxValue;
        return sinceMs >= span.SinceMs && sinceMs <= end;
    }

    private void AbsorbOverlaps(GapSpan keeper, long absorbUntil)
    {
        for (var i = _gaps.Count - 1; i >= 0; i--)
        {
            var other = _gaps[i];
            if (ReferenceEquals(other, keeper))
            {
                continue;
            }

            var end = other.UntilMs ?? long.MaxValue;
            if (end < keeper.SinceMs || other.SinceMs > absorbUntil)
            {
                continue;
            }

            _gaps.RemoveAt(i);
        }
    }

    private int WriteSpan(GapSpan span, Dictionary<long, HistoricalMinuteBar> byStart)
    {
        var limit = WriteUntil(span);
        if (limit == long.MaxValue)
        {
            return 0;
        }

        var written = 0;
        for (var start = FloorMinute(span.SinceMs); start + MinuteMs <= limit; start += MinuteMs)
        {
            // A mid-minute drop still owns this bin when the bin is empty. A live partial is left alone below.
            if (!byStart.TryGetValue(start, out var bar) || bar.Volume <= 0)
            {
                continue;
            }

            if (TryWriteMinute(start, bar))
            {
                written++;
            }
        }

        return written;
    }

    private long WriteUntil(GapSpan span)
    {
        var limit = long.MaxValue;
        if (span.UntilMs is { } until)
        {
            limit = Math.Min(limit, until);
        }

        // A live print inside the hole does not cap later empty minutes. TryWriteMinute leaves the minute
        // that already holds the print; the exchange time is not a ceiling (D-33).
        if (_minuteBars.Current is { } current)
        {
            limit = Math.Min(limit, current.StartMs);
        }
        else if (_lastMarketMs != long.MinValue)
        {
            limit = Math.Min(limit, FloorMinute(_lastMarketMs));
        }

        return limit;
    }

    /// <summary>
    /// Replaces an empty closed minute. Returns false when the minute already has live volume or sits on the
    /// forward cursor. Does not move <c>_lastPrice</c> or <c>_lastTradeMs</c>.
    /// </summary>
    private bool TryWriteMinute(long startMs, HistoricalMinuteBar bar)
    {
        if (_minuteBars.Current is { } current && startMs >= current.StartMs)
        {
            return false;
        }

        if (_sessionId is not null)
        {
            var session = _calendar.SessionFor(DateTimeOffset.FromUnixTimeMilliseconds(startMs));
            if (session.Id != _sessionId)
            {
                return false;
            }
        }

        var index = -1;
        for (var i = 0; i < _closedMinutes.Count; i++)
        {
            if (_closedMinutes[i].StartMs == startMs)
            {
                index = i;
                break;
            }
        }

        if (index >= 0 && !_closedMinutes[index].IsEmpty)
        {
            return false;
        }

        var repaired = new TradeBar
        {
            StartMs = startMs,
            DurationMs = MinuteMs,
            Open = bar.OpenTicks,
            High = bar.HighTicks,
            Low = bar.LowTicks,
            Close = bar.CloseTicks,
            Volume = bar.Volume,
            BuyVolume = bar.Volume / 2,
            SellVolume = bar.Volume - (bar.Volume / 2),
            TradeCount = 1,
        };
        if (index >= 0)
        {
            _closedMinutes[index] = repaired;
            ObserveRips(repaired);
        }
        else
        {
            var at = _closedMinutes.FindIndex(existing => existing.StartMs > startMs);
            if (at < 0)
            {
                KeepMinute(repaired);
            }
            else
            {
                _closedMinutes.Insert(at, repaired);
                ObserveRips(repaired);
            }
        }

        var end = startMs + MinuteMs;
        foreach (var (price, quantity) in OrderFlowAnalyzer.SplitPrices(bar.OpenTicks, bar.HighTicks, bar.LowTicks, bar.CloseTicks, bar.Volume))
        {
            _sessionProfile.Add(startMs, price, quantity);
            _profile1h.Add(startMs, price, quantity);
            _profile4h.Add(startMs, price, quantity);
            _profile5d.Add(startMs, price, quantity);
            _vwap.Add(price, quantity);
        }

        _sessionVolume += bar.Volume;
        _sessionOpen ??= bar.OpenTicks;
        _sessionHigh = _sessionHigh is { } high ? Math.Max(high, bar.HighTicks) : bar.HighTicks;
        _sessionLow = _sessionLow is { } low ? Math.Min(low, bar.LowTicks) : bar.LowTicks;
        if (_orderFlow.PlaceApproximateMinute(startMs, bar.OpenTicks, bar.HighTicks, bar.LowTicks, bar.CloseTicks, bar.Volume))
        {
            _republishFootprints.Add(startMs);
        }

        _repairedMinutes.Add(startMs);
        _republishMinutes.Add(startMs);
        NoteApproximate(startMs, end);
        return true;
    }

    private bool IsRepairedMinute(long exchangeMs)
    {
        var start = FloorMinute(exchangeMs);
        if (start < _retiredRepairFloorMs || _repairedMinutes.Contains(start))
        {
            return true;
        }

        foreach (var range in _retiredRepairs)
        {
            if (start >= range.StartMs && start < range.EndMs)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Moves repaired minutes that have left the history window out of the hot set. A late print in one of them
    /// is still ignored, so it is not added a second time. The retired ranges are cleared on session roll.
    /// </summary>
    private void PruneRepairedMinutes(long cutoffMs)
    {
        if (_repairedMinutes.Count == 0)
        {
            return;
        }

        List<long>? removed = null;
        foreach (var start in _repairedMinutes)
        {
            if (start < cutoffMs)
            {
                (removed ??= []).Add(start);
            }
        }

        if (removed is null)
        {
            return;
        }

        foreach (var start in removed)
        {
            _repairedMinutes.Remove(start);
            RetireRepair(start, start + MinuteMs);
        }
    }

    private void RetireRepair(long startMs, long endMs)
    {
        var merged = false;
        for (var i = 0; i < _retiredRepairs.Count; i++)
        {
            var range = _retiredRepairs[i];
            if (endMs < range.StartMs || startMs > range.EndMs)
            {
                continue;
            }

            _retiredRepairs[i] = (Math.Min(range.StartMs, startMs), Math.Max(range.EndMs, endMs));
            merged = true;
            break;
        }

        if (!merged)
        {
            _retiredRepairs.Add((startMs, endMs));
        }

        _retiredRepairs.Sort(static (left, right) => left.StartMs.CompareTo(right.StartMs));
        for (var i = 0; i < _retiredRepairs.Count - 1;)
        {
            var left = _retiredRepairs[i];
            var right = _retiredRepairs[i + 1];
            if (left.EndMs < right.StartMs)
            {
                i++;
                continue;
            }

            _retiredRepairs[i] = (left.StartMs, Math.Max(left.EndMs, right.EndMs));
            _retiredRepairs.RemoveAt(i + 1);
        }

        while (_retiredRepairs.Count > VolumeProfile.MaxClosedRanges)
        {
            _retiredRepairFloorMs = Math.Max(_retiredRepairFloorMs, _retiredRepairs[0].EndMs);
            _retiredRepairs.RemoveAt(0);
        }
    }

    /// <summary>
    /// A print inside an unfinished hole whose minute is already behind the forward cursor. Applying it would
    /// fold the old exchange time into the forming bar.
    /// </summary>
    private bool IsStalePrintInHole(long exchangeMs)
    {
        if (_minuteBars.Current is not { } current || FloorMinute(exchangeMs) >= current.StartMs)
        {
            return false;
        }

        foreach (var span in _gaps)
        {
            if (span.Complete)
            {
                continue;
            }

            var end = span.UntilMs ?? long.MaxValue;
            if (exchangeMs >= span.SinceMs && exchangeMs < end)
            {
                return true;
            }
        }

        return false;
    }

    private bool MinuteHasVolume(long startMs)
    {
        if (_minuteBars.Current is { } current && current.StartMs == startMs && !current.IsEmpty)
        {
            return true;
        }

        foreach (var bar in _closedMinutes)
        {
            if (bar.StartMs == startMs)
            {
                return !bar.IsEmpty;
            }
        }

        return false;
    }

    /// <summary>Clears the in-flight flag once every hole is settled. A quiet poll must not leave the contract DEGRADED.</summary>
    public void NoteRepairSettled()
    {
        lock (_gate)
        {
            foreach (var span in _gaps)
            {
                if (!span.Complete)
                {
                    return;
                }
            }

            _repairArmed = false;
        }
    }

    private static long FloorMinute(long ms) => ms - (((ms % MinuteMs) + MinuteMs) % MinuteMs);

    private void TrimCompletedGaps()
    {
        var complete = 0;
        foreach (var span in _gaps)
        {
            if (span.Complete)
            {
                complete++;
            }
        }

        while (complete > VolumeProfile.MaxClosedRanges)
        {
            var index = _gaps.FindIndex(span => span.Complete);
            if (index < 0)
            {
                break;
            }

            _gaps.RemoveAt(index);
            complete--;
        }
    }

    /// <summary>Ends the open gap. The recorded hole stays on the bars and profiles until they roll off (D-32).</summary>
    private void CloseOpenGap(long? gatewayMs, long sourceMs)
    {
        var open = OpenSpan();
        if (_missingSinceMs is null && open is null)
        {
            return;
        }

        var since = open?.SinceMs ?? _missingSinceMs ?? sourceMs;
        // A far-future drop is kept on the span, but it cannot push a good resubscribe into the future (D-32).
        var untilMs = ResolveGapEnd(gatewayMs, sourceMs, since, _missingThroughMs);
        if (open is not null)
        {
            open.UntilMs = untilMs;
            if (!open.Complete)
            {
                _repairKick = true;
            }
        }

        _missingSinceMs = null;
        _missingThroughMs = 0;
        _resubscribeAfterGap = false;
        // A fresh resubscribe, the no-depth epoch bump, or the next session anchors CVD again.
        // The repair does not: a minute bar still has no aggressor (D-33).
        _cvdKnown = true;
        foreach (var profile in Profiles())
        {
            var dropped = profile.CloseMissing(untilMs);
            if (dropped > 0)
            {
                _missingRangesDropped[profile.Window] = _missingRangesDropped.GetValueOrDefault(profile.Window) + dropped;
            }
        }
    }

    /// <summary>
    /// Where the hole ends. A gateway stamp after the drop, and not more than <see cref="MaxClockAheadMs"/> ahead of
    /// the event, wins. Otherwise the stream died before a usable exchange stamp: the event's own time and every
    /// later dropped trade still have to stay inside the hole, so it does not collapse to one millisecond.
    /// </summary>
    private static long ResolveGapEnd(long? gatewayMs, long sourceMs, long sinceMs, long throughMs)
    {
        long end;
        if (gatewayMs is { } gateway && gateway <= sourceMs + MaxClockAheadMs && gateway >= sinceMs + 1)
        {
            end = gateway;
        }
        else if (sourceMs >= sinceMs + 1)
        {
            end = sourceMs;
        }
        else
        {
            end = sinceMs + 1;
        }

        // Dropped trades never pass Accept, so a stamp more than a minute ahead of the close is not a clock.
        // The end is exclusive: a drop on a bar boundary still belongs to that bar.
        if (throughMs > end && throughMs <= sourceMs + MaxClockAheadMs)
        {
            end = throughMs + 1;
        }

        return end;
    }

    /// <summary>
    /// A trade stamp more than <see cref="MaxClockAheadMs"/> after it was received is ignored. Dropped trades do not
    /// pass <see cref="Accept"/>, so their recorders use this before the stamp becomes a hole bound (D-32).
    /// </summary>
    public static long AcceptedStamp(long stampMs, long receivedMs) =>
        stampMs > receivedMs + MaxClockAheadMs ? receivedMs : stampMs;

    private void NoteMissing(long sinceMs)
    {
        foreach (var profile in Profiles())
        {
            profile.MarkMissingSince(sinceMs);
        }
    }

    private void NoteApproximate(long sinceMs, long untilMs)
    {
        foreach (var profile in Profiles())
        {
            profile.MarkApproximate(sinceMs, untilMs);
        }
    }

    private IEnumerable<VolumeProfile> Profiles() => [_sessionProfile, _profile1h, _profile4h, _profile5d];

    /// <summary>A bar overlaps a recorded hole when it ends after the hole starts and starts before the hole ends.</summary>
    private bool BarIsMissing(long startMs, long endMs)
    {
        foreach (var profile in Profiles())
        {
            foreach (var range in profile.Ranges())
            {
                var until = range.UntilMs ?? long.MaxValue;
                if (endMs > range.SinceMs && startMs < until)
                {
                    return true;
                }
            }
        }

        return false;
    }

    private bool BarIsApproximate(long startMs, long endMs)
    {
        foreach (var profile in Profiles())
        {
            foreach (var range in profile.ApproximateRanges)
            {
                var until = range.UntilMs ?? long.MaxValue;
                if (endMs > range.SinceMs && startMs < until)
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>Applies one normalized event (INTERFACES.md Interface A, A.5).</summary>
    public void Apply(MarketEvent marketEvent)
    {
        ArgumentNullException.ThrowIfNull(marketEvent);
        lock (_gate)
        {
            if (!Accept(marketEvent))
            {
                return;
            }

            _collectionStartMs ??= marketEvent.SourceTimeMs;
            _lastReceivedMs = Math.Max(_lastReceivedMs, marketEvent.ReceivedTimeMs);
            var t = Math.Max(marketEvent.SourceTimeMs, _lastMarketMs == long.MinValue ? marketEvent.SourceTimeMs : _lastMarketMs);
            _lastMarketMs = t;
            AdvanceLocked(t);
            switch (marketEvent)
            {
                case DepthSnapshotEvent snapshot:
                    if (snapshot.Resubscribe && _resubscribeAfterGap)
                    {
                        CloseOpenGap(snapshot.GatewayTimeMs, snapshot.SourceTimeMs);
                    }

                    _resubscribeAfterGap = false;
                    _book.ApplySnapshot(snapshot);
                    _flows.Reset();
                    _walls.Reset();
                    _orderFlow.Invalidate();
                    SetEpoch(snapshot.Epoch);
                    NoteTop(snapshot);
                    break;
                case DepthUpdateEvent update:
                    NoteTop(update);
                    if (_book.Apply(update.Side, update.PriceTicks, update.Quantity) is { } change)
                    {
                        _walls.OnLevelChange(change, _flows.OnLevelChange(t, change));
                        _orderFlow.OnLevelChange(t, change, _book);
                    }

                    break;
                case BookResetEvent reset:
                    Invalidate();
                    _resubscribeAfterGap = _missingSinceMs is not null && reset.Reason == BookResetEvent.SubscribedReason;
                    break;
                case TradeEvent trade:
                    if ((_historyWatermarkMs is { } mark && trade.SourceTimeMs <= mark) || !_dedup.Accept(trade.TradeId))
                    {
                        break;
                    }

                    if (IsRepairedMinute(trade.SourceTimeMs) || IsStalePrintInHole(trade.SourceTimeMs))
                    {
                        // The closed bar already holds this minute, or the print is behind the cursor inside an
                        // unfinished hole. Adding it would put the old exchange time in the forming bar (D-33).
                        if (_lastTradeMs is null || trade.SourceTimeMs >= _lastTradeMs)
                        {
                            _lastTradeMs = trade.SourceTimeMs;
                            _lastPrice = trade.PriceTicks;
                        }

                        break;
                    }

                    var displayed = _book.IsKnown
                        ? _book.QuantityAt(trade.Aggressor == BookSide.Bid ? BookSide.Ask : BookSide.Bid, trade.PriceTicks)
                        : null;
                    _flows.OnTrade(t, trade);
                    ApplyTrade(trade, live: true, displayed);
                    break;
                case FeedStatusEvent status:
                    _provenance = status.Provenance;
                    _connected = status.Connected;
                    SetEpoch(status.Epoch);
                    _depthSubscribed = status.DepthSubscribed;
                    if (!status.Connected)
                    {
                        Invalidate();
                    }
                    else if (!status.DepthSubscribed)
                    {
                        // Depth switched off on purpose (nobody watches this product): the book is unknown, but
                        // that is not a fault, so it is not counted as a reset.
                        Invalidate(countReset: false);
                        // No depth snapshot will arrive. A newer epoch is this contract's resubscribe.
                        if (_missingSinceMs is not null && status.Epoch > _gapEpoch)
                        {
                            CloseOpenGap(status.GatewayTimeMs, status.SourceTimeMs);
                        }
                    }

                    break;
                case QuoteEvent quote:
                    if (quote.BidTicks is { } qb && quote.AskTicks is { } qa && qa <= qb)
                    {
                        // A crossed or locked quote is a bad print; keep the previous top of book.
                        _rejected++;
                        break;
                    }

                    _quoteBid = quote.BidTicks ?? _quoteBid;
                    _quoteAsk = quote.AskTicks ?? _quoteAsk;
                    NoteTop(quote);
                    break;
                default:
                    _rejected++;
                    break;
            }
        }
    }

    /// <summary>Advances the clock without an event: closes slices and bars, expires rolling windows, detects STALE.</summary>
    public void Tick(long nowMs)
    {
        lock (_gate)
        {
            _nowMs = Math.Max(_nowMs, nowMs);
            if (_lastMarketMs != long.MinValue && nowMs > _lastMarketMs)
            {
                // Market time follows the wall clock between events so empty slices still close on time.
                _lastMarketMs = nowMs;
                AdvanceLocked(nowMs);
            }
        }
    }

    public DashboardSnapshot Snapshot(int historyMinutes, Overlay? overlay)
    {
        lock (_gate)
        {
            // Before the first live event the anchor is the end of the warmup (or now), never long.MinValue, which wraps.
            var anchorMs = _lastMarketMs != long.MinValue ? _lastMarketMs : _historyWatermarkMs ?? _nowMs;
            var requested = Math.Max(1, historyMinutes);
            var fineMinutes = Math.Min(requested, _options.RetentionMinutes);
            var longMinutes = Math.Min(requested, _options.HistoryRetentionMinutes);
            var fromMs = anchorMs - (fineMinutes * (long)MinuteMs);
            var longFromMs = anchorMs - (longMinutes * (long)MinuteMs);
            return new DashboardSnapshot
            {
                Root = Spec.Root.ToString(),
                Seq = _seq,
                ServerTimeMs = _nowMs,
                Instrument = Info,
                Status = StatusLocked(),
                Heat = _heat.Where(c => c.StartMs >= fromMs).Select(ToDto).ToList(),
                Bars = _bars.Where(b => b.StartMs >= fromMs).Select(ToDto).ToList(),
                DevelopingBar = _secondBars.Current is { } dev ? ToDto(dev) : null,
                MinuteBars = _closedMinutes.Where(b => b.StartMs >= longFromMs).Select(ToDto).ToList(),
                DevelopingMinute = _minuteBars.Current is { IsEmpty: false } minute ? ToDto(minute) : null,
                MinuteHeat = _minuteHeat.Where(c => c.StartMs >= longFromMs).Select(ToDto).ToList(),
                DevelopingMinuteHeat = OpenMinuteHeat(longFromMs),
                LevelTouches = TouchesLocked(),
                Indicators = AllIndicators(full: true).Select(ToDto).ToList(),
                Profiles = ProfilesLocked(),
                Vwap = VwapLocked(),
                Liquidity = LiquidityLocked(),
                Ladder = LadderLocked(),
                Overlay = ToDto(overlay),
                SessionHigh = _sessionHigh,
                SessionLow = _sessionLow,
                HistoryWatermarkMs = _historyWatermarkMs,
                RangeZones = RangeZonesLocked(),
                Prints = _prints.ToList(),
                OrderFlow = OrderFlowLocked(
                    _orderFlow.ClosedFootprints.Where(f => f.StartMs >= fromMs).ToList(),
                    _orderFlow.CvdSeries,
                    _orderFlow.Signals.InWindow(longFromMs).ToList()),
            };
        }
    }

    /// <summary>Everything new since the previous call, with the next publication sequence number.</summary>
    public DashboardDelta Publish(Overlay? overlay)
    {
        lock (_gate)
        {
            var heat = NewSince(_heat, c => c.StartMs, _publishedHeatMs);
            var bars = NewSince(_bars, b => b.StartMs, _publishedBarMs);
            var minuteHeat = NewSince(_minuteHeat, c => c.StartMs, _publishedMinuteHeatMs);
            var minuteBars = NewSince(_closedMinutes, b => b.StartMs, _publishedMinuteBarMs);
            foreach (var start in _republishMinutes)
            {
                var repaired = _closedMinutes.Find(bar => bar.StartMs == start);
                if (repaired is not null && minuteBars.TrueForAll(bar => bar.StartMs != start))
                {
                    minuteBars.Add(repaired);
                }
            }

            _republishMinutes.Clear();
            minuteBars.Sort(static (left, right) => left.StartMs.CompareTo(right.StartMs));
            var indicators = AllIndicators(full: false);
            if (heat.Count > 0)
            {
                _publishedHeatMs = heat[^1].StartMs;
            }

            if (bars.Count > 0)
            {
                _publishedBarMs = bars[^1].StartMs;
            }

            if (minuteHeat.Count > 0)
            {
                _publishedMinuteHeatMs = minuteHeat[^1].StartMs;
            }

            if (minuteBars.Count > 0)
            {
                _publishedMinuteBarMs = minuteBars[^1].StartMs;
            }

            var footprints = _orderFlow.ClosedFootprints.Where(f => f.StartMs > _publishedFootprintMs).ToList();
            foreach (var start in _republishFootprints)
            {
                FootprintBar? repaired = null;
                foreach (var bar in _orderFlow.ClosedFootprints)
                {
                    if (bar.StartMs == start)
                    {
                        repaired = bar;
                        break;
                    }
                }

                if (repaired is { IsEmpty: false } && footprints.TrueForAll(bar => bar.StartMs != start))
                {
                    footprints.Add(repaired);
                }
            }

            _republishFootprints.Clear();
            footprints.Sort(static (left, right) => left.StartMs.CompareTo(right.StartMs));
            if (footprints.Count > 0)
            {
                _publishedFootprintMs = footprints[^1].StartMs;
            }

            var signals = _orderFlow.Signals.Since(_publishedSignalId);
            _publishedSignalId = _orderFlow.Signals.LastId;
            var prints = PrintsSincePublished();
            var cvd = footprints.Count == 0
                ? []
                : _orderFlow.CvdSeries.Where(p => p.EndMs > footprints[0].StartMs).ToList();
            var latestIndicator = indicators.SelectMany(i => i.Points).Select(p => p.TimeMs).DefaultIfEmpty(long.MinValue).Max();
            _publishedIndicatorMs = Math.Max(_publishedIndicatorMs, latestIndicator);
            var zoneVersion = RangeZoneVersionLocked();
            var rangeZones = zoneVersion != _publishedRangeZoneVersion ? RangeZonesLocked() : null;
            _publishedRangeZoneVersion = zoneVersion;
            _seq++;
            return new DashboardDelta
            {
                Root = Spec.Root.ToString(),
                Seq = _seq,
                ServerTimeMs = _nowMs,
                Status = StatusLocked(),
                Heat = heat.Select(ToDto).ToList(),
                Bars = bars.Select(ToDto).ToList(),
                DevelopingBar = _secondBars.Current is { } dev ? ToDto(dev) : null,
                MinuteBars = minuteBars.Select(ToDto).ToList(),
                DevelopingMinute = _minuteBars.Current is { IsEmpty: false } minute ? ToDto(minute) : null,
                MinuteHeat = minuteHeat.Select(ToDto).ToList(),
                DevelopingMinuteHeat = OpenMinuteHeat(long.MinValue),
                LevelTouches = TouchesLocked(),
                Indicators = indicators.Select(ToDto).ToList(),
                Profiles = ProfilesLocked(),
                Vwap = VwapLocked(),
                Liquidity = LiquidityLocked(),
                Ladder = LadderLocked(),
                Overlay = ToDto(overlay),
                SessionHigh = _sessionHigh,
                SessionLow = _sessionLow,
                Prints = prints,
                RangeZones = rangeZones,
                OrderFlow = OrderFlowLocked(footprints, cvd, signals),
            };
        }
    }

    /// <summary>
    /// Viewers subscribed to this engine's deltas (REQUIREMENTS.md FR-54). While there are none, <see cref="PublishIfWatched"/>
    /// builds nothing.
    /// </summary>
    public int Watchers
    {
        get
        {
            lock (_gate)
            {
                return _watchers;
            }
        }
    }

    /// <summary>
    /// Counts one more viewer and returns the snapshot it starts from, atomically: a publication that runs after this
    /// call is a real delta, so the viewer never sees a sequence gap that a skipped publication would leave.
    /// </summary>
    public DashboardSnapshot Watch(int historyMinutes, Overlay? overlay)
    {
        lock (_gate)
        {
            _watchers++;
            return Snapshot(historyMinutes, overlay);
        }
    }

    /// <summary>One viewer fewer; never below zero.</summary>
    public void Unwatch()
    {
        lock (_gate)
        {
            _watchers = Math.Max(0, _watchers - 1);
        }
    }

    /// <summary>
    /// <see cref="Publish"/> when anyone watches; otherwise only moves the publication watermarks and the sequence on,
    /// without building a delta, and returns null. The next subscriber's snapshot includes everything up to now, so
    /// nothing the skipped publications would have carried is lost to it.
    /// </summary>
    public DashboardDelta? PublishIfWatched(Overlay? overlay)
    {
        lock (_gate)
        {
            if (_watchers > 0)
            {
                return Publish(overlay);
            }

            if (_heat.Count > 0)
            {
                _publishedHeatMs = Math.Max(_publishedHeatMs, _heat[^1].StartMs);
            }

            if (_bars.Count > 0)
            {
                _publishedBarMs = Math.Max(_publishedBarMs, _bars[^1].StartMs);
            }

            if (_orderFlow.ClosedFootprints.Count > 0)
            {
                _publishedFootprintMs = Math.Max(_publishedFootprintMs, _orderFlow.ClosedFootprints[^1].StartMs);
            }

            _publishedSignalId = _orderFlow.Signals.LastId;
            _publishedIndicatorMs = Math.Max(_publishedIndicatorMs, LatestIndicatorMs());
            _publishedRangeZoneVersion = RangeZoneVersionLocked();
            if (_prints.Count > 0)
            {
                _publishedPrintSequence = Math.Max(_publishedPrintSequence, _prints[^1].Sequence);
            }

            _seq++;
            return null;
        }
    }

    /// <summary>The one-row market summary of the product picker (REQUIREMENTS.md FR-55): cheap, no series.</summary>
    public MarketSummaryDto Summary()
    {
        lock (_gate)
        {
            var bid = _book.IsKnown ? _book.BestBid : _quoteBid;
            var ask = _book.IsKnown ? _book.BestAsk : _quoteAsk;
            var cutoff10 = _nowMs - 10_000;
            long delta60 = 0;
            long quantity10 = 0;
            foreach (var trade in _recentTrades)
            {
                delta60 += trade.Delta;
                if (trade.TimeMs > cutoff10)
                {
                    quantity10 += trade.Quantity;
                }
            }

            var cutoff15 = _nowMs - (15 * MinuteMs);
            return new MarketSummaryDto(
                _lastPrice, bid, ask, _sessionOpen, _sessionHigh, _sessionLow, _sessionVolume, _cumulativeDelta, delta60,
                quantity10 / 10.0, _lastTradeMs,
                _orderFlow.Signals.Newest,
                _orderFlow.Signals.CountAfter(cutoff15),
                _regimes.Select(r => r.State()).ToList(),
                TapeLocked());
        }
    }

    /// <summary>The read-only analytics snapshot for an agent (INTERFACES.md Interface C).</summary>
    public AgentContext Context()
    {
        lock (_gate)
        {
            var indicators = _oneMinuteIndicators.Series(includeDeveloping: false)
                .Where(s => s.Ready)
                .ToDictionary(
                    s => s.Id,
                    s => (IReadOnlyList<double?>)s.Points[^1].Values
                        .Select(v => double.IsNaN(v) ? (double?)null : s.Kind == IndicatorKind.Rsi ? v : v * (double)Spec.TickSize)
                        .ToList());
            var vwap = VwapLocked();
            return new AgentContext
            {
                Instrument = Info,
                AsOfMs = _nowMs,
                Status = StatusLocked(),
                LastPrice = _lastPrice is { } p ? Spec.ToPrice(p) : null,
                SessionHigh = _sessionHigh is { } h ? Spec.ToPrice(h) : null,
                SessionLow = _sessionLow is { } l ? Spec.ToPrice(l) : null,
                Vwap = vwap with
                {
                    Vwap = vwap.Vwap * (double)Spec.TickSize,
                    StdDev = vwap.StdDev * (double)Spec.TickSize,
                },
                Indicators = indicators,
                Profiles = ProfilesLocked(),
                Liquidity = LiquidityLocked(),
                RecentMinuteBars = _closedMinutes.TakeLast(30).Select(ToDto).ToList(),
                RecentSignals = _orderFlow.Signals.TakeLast(25),
                Icebergs = _orderFlow.Icebergs,
                KeyLevels = _orderFlow.KeyLevels(),
                Cvd = _orderFlow.Cvd,
            };
        }
    }

    /// <summary>
    /// Everything the plan metrics read (REQUIREMENTS.md FR-73, ARCHITECTURE.md D-60), gathered in one consistent reading.
    /// The book is listed price by price across the covered depth, unknown levels as null (REQUIREMENTS.md FR-11).
    /// </summary>
    public PlanMarket PlanMarket(Overlay? overlay)
    {
        lock (_gate)
        {
            var session = _sessionProfile.Snapshot();
            var flowPartial = !_cvdKnown
                || session.PartialSinceMs is not null
                || session.MissingRanges.Count > 0
                || session.ApproximateRanges.Count > 0;
            var atr = _oneMinuteIndicators.Series(includeDeveloping: false)
                .FirstOrDefault(s => s.Kind == IndicatorKind.Atr && s.Ready && s.Points.Count > 0);
            double? atrTicks = atr is { } a && a.Points[^1].Values is [var value, ..] && double.IsFinite(value) ? value : null;
            return new PlanMarket
            {
                Root = Spec.Root.ToString(),
                ContractId = Spec.ContractId,
                AsOfMs = _nowMs,
                StatusCode = StatusLocked().Code,
                LastTicks = _lastPrice,
                AtrTicks = atrTicks,
                Book = PlanBookLocked(),
                SliceMs = _options.SliceMs,
                RecentHeat = _heat.Where(c => c.StartMs >= _nowMs - PlanMetricsCalculator.RestingWindowMs - _options.SliceMs).ToList(),
                Minutes = _closedMinutes
                    .Select(m => new PlanMinute(m.StartMs, m.High, m.Low, BarIsMissing(m.StartMs, m.EndMs) && !BarIsApproximate(m.StartMs, m.EndMs)))
                    .ToList(),
                Walls = _walls.Detect(_nowMs, _book),
                Icebergs = _orderFlow.Icebergs,
                Signals = _orderFlow.Signals.InWindow(_nowMs - PlanMetricsCalculator.SignalWindowMs),
                Zones = _orderFlow.Zones.ToList(),
                UnfinishedAuctions = _orderFlow.UnfinishedAuctions.ToList(),
                Levels = PlanLevelsLocked(session, overlay),
                SessionDeltaByPrice = new Dictionary<long, long>(_sessionDelta),
                Regimes = _regimes.Select(r => r.State()).ToList(),
                Coverage = new PlanCoverage
                {
                    ProfilePartialSinceMs = session.PartialSinceMs,
                    VwapPartial = _vwap.IsPartial,
                    FlowPartial = flowPartial,
                    MissingSinceMs = _missingSinceMs,
                },
            };
        }
    }

    private PlanBook PlanBookLocked()
    {
        if (!_book.IsKnown)
        {
            return Plans.PlanBook.Unknown;
        }

        var cells = new List<PlanBookCell>();
        if (_book.CoveredLow is { } low && _book.CoveredHigh is { } high)
        {
            for (var price = low; price <= high; price++)
            {
                cells.Add(new PlanBookCell(price, _book.QuantityAt(BookSide.Bid, price), _book.QuantityAt(BookSide.Ask, price)));
            }
        }

        return new PlanBook(true, _book.BestBid, _book.BestAsk, _book.CoveredLow, _book.CoveredHigh, cells);
    }

    private List<PlanLevel> PlanLevelsLocked(ProfileSnapshot session, Overlay? overlay)
    {
        var levels = new List<PlanLevel>();
        if (session.ValueArea is { } va)
        {
            levels.Add(new PlanLevel("profile", "POC", va.PocTicks));
            levels.Add(new PlanLevel("profile", "VAH", va.HighTicks));
            levels.Add(new PlanLevel("profile", "VAL", va.LowTicks));
        }

        foreach (var node in ProfileNodes.Find(session.Bins, _options.OrderFlow))
        {
            levels.Add(new PlanLevel("profile", node.IsHigh ? "HVN" : "LVN", node.PriceTicks));
        }

        if (_vwap.Value is { } v)
        {
            var bands = VwapBands.From(v);
            levels.Add(new PlanLevel("vwap", "VWAP", Tick(bands.Vwap)));
            levels.Add(new PlanLevel("vwap", "VWAP +1SD", Tick(bands.Plus1)));
            levels.Add(new PlanLevel("vwap", "VWAP -1SD", Tick(bands.Minus1)));
            levels.Add(new PlanLevel("vwap", "VWAP +2SD", Tick(bands.Plus2)));
            levels.Add(new PlanLevel("vwap", "VWAP -2SD", Tick(bands.Minus2)));
        }

        foreach (var level in _orderFlow.KeyLevels())
        {
            if (level.Name is "prior session high" or "prior session low")
            {
                levels.Add(new PlanLevel("prior-session", level.Name, level.PriceTicks));
            }
        }

        if (overlay is not null && overlay.Request.ExpiresAt.ToUnixTimeMilliseconds() > _nowMs)
        {
            foreach (var level in overlay.Request.Levels)
            {
                if (Spec.TryToTicks(level.Price, out var ticks))
                {
                    levels.Add(new PlanLevel("overlay", level.Label, ticks));
                }
            }
        }

        return levels;
    }

    private static long Tick(double priceTicks) => (long)Math.Round(priceTicks, MidpointRounding.AwayFromZero);

    public StatusDto Status()
    {
        lock (_gate)
        {
            return StatusLocked();
        }
    }

    private bool Accept(MarketEvent e)
    {
        if (e.Root != Spec.Root || !string.Equals(e.ContractId, Spec.ContractId, StringComparison.Ordinal))
        {
            // Another contract never mixes into this book or profile (REQUIREMENTS.md FR-5).
            _rejected++;
            return false;
        }

        if (e.SourceTimeMs > e.ReceivedTimeMs + MaxClockAheadMs)
        {
            // An event stamped well after it arrived is a bad timestamp; accepting it would drag the engine's clock
            // forward and clamp every later event to it.
            _rejected++;
            _rejectedClockAhead++;
            return false;
        }

        return true;
    }

    private void Invalidate(bool countReset = true)
    {
        if (_book.IsKnown && countReset)
        {
            _resets++;
        }

        _book.Invalidate();
        _flows.Reset();
        _orderFlow.Invalidate();
    }

    private void AdvanceLocked(long t)
    {
        _nowMs = Math.Max(_nowMs, t);
        _tape.AdvanceTo(t);
        var retention = _options.RetentionMinutes * (long)MinuteMs;
        foreach (var column in _integrator.Advance(t, _book))
        {
            _heat.Add(column);
            FoldHeat(column);
        }

        foreach (var bar in _secondBars.AdvanceTo(t))
        {
            _bars.Add(bar);
        }

        foreach (var minute in _minuteBars.AdvanceTo(t))
        {
            KeepMinute(minute);
        }

        AdvanceIndicators(t);
        foreach (var regime in _regimes)
        {
            regime.AdvanceTo(t);
        }

        _orderFlow.Advance(t);
        _profile1h.Expire(t);
        _profile4h.Expire(t);
        _profile5d.Expire(t);
        Trim(_heat, c => c.StartMs, t - retention);
        Trim(_bars, b => b.StartMs, t - retention);
        var historyCutoff = t - (_options.HistoryRetentionMinutes * (long)MinuteMs);
        Trim(_minuteHeat, c => c.StartMs, historyCutoff);
        Trim(_closedMinutes, b => b.StartMs, historyCutoff);
        PruneRepairedMinutes(historyCutoff);
        foreach (var regime in _regimes)
        {
            regime.TrimRangeZones(historyCutoff);
        }
        while (_recentTrades.Count > 0 && _recentTrades.Peek().TimeMs <= t - MinuteMs)
        {
            _recentTrades.Dequeue();
        }
    }

    private void ApplyTrade(TradeEvent trade, bool live, long? displayed)
    {
        var t = trade.SourceTimeMs;
        if (!live)
        {
            AdvanceHistory(t);
        }

        var session = _calendar.SessionFor(DateTimeOffset.FromUnixTimeMilliseconds(t));
        if (_sessionId != session.Id)
        {
            var openMs = session.Open.ToUnixTimeMilliseconds();
            StartSession(session.Id, openMs, t > openMs + MinuteMs ? t : null);
        }

        // Before the detectors, so a signal this print raises is judged with it.
        _tape.Add(t, trade.Quantity, live);
        var buyer = trade.Aggressor == BookSide.Bid;
        var signed = buyer ? trade.Quantity : -trade.Quantity;
        foreach (var bar in _secondBars.Add(t, trade.PriceTicks, trade.Quantity, buyer))
        {
            _bars.Add(bar);
        }

        foreach (var minute in _minuteBars.Add(t, trade.PriceTicks, trade.Quantity, buyer))
        {
            KeepMinute(minute);
        }

        AddIndicatorTrade(t, trade.PriceTicks, trade.Quantity, buyer);
        foreach (var regime in _regimes)
        {
            regime.AddTrade(t, trade.PriceTicks, trade.Quantity, buyer);
        }

        _vwap.Add(trade.PriceTicks, trade.Quantity);
        _sessionProfile.Add(t, trade.PriceTicks, trade.Quantity);
        _profile1h.Add(t, trade.PriceTicks, trade.Quantity);
        _profile4h.Add(t, trade.PriceTicks, trade.Quantity);
        _profile5d.Add(t, trade.PriceTicks, trade.Quantity);
        _orderFlow.OnTrade(t, trade.PriceTicks, trade.Quantity, buyer, displayed, live);
        _cumulativeDelta += signed;
        _sessionDelta[trade.PriceTicks] = _sessionDelta.GetValueOrDefault(trade.PriceTicks) + signed;
        _sessionVolume += trade.Quantity;
        _sessionOpen ??= trade.PriceTicks;
        _lastTradeMs = t;
        _sessionHigh = _sessionHigh is { } h ? Math.Max(h, trade.PriceTicks) : trade.PriceTicks;
        _sessionLow = _sessionLow is { } l ? Math.Min(l, trade.PriceTicks) : trade.PriceTicks;
        _lastPrice = trade.PriceTicks;
        if (live)
        {
            _recentTrades.Enqueue((t, trade.Quantity, signed));
            RememberPrint(trade);
        }
    }

    private void AdvanceHistory(long t)
    {
        _tape.AdvanceTo(t);
        var retention = _options.RetentionMinutes * (long)MinuteMs;
        foreach (var bar in _secondBars.AdvanceTo(t))
        {
            _bars.Add(bar);
        }

        foreach (var minute in _minuteBars.AdvanceTo(t))
        {
            KeepMinute(minute);
        }

        AdvanceIndicators(t);
        foreach (var regime in _regimes)
        {
            regime.AdvanceTo(t);
        }

        _orderFlow.Advance(t);
        _profile1h.Expire(t);
        _profile4h.Expire(t);
        _profile5d.Expire(t);
        var historyCutoff = t - (_options.HistoryRetentionMinutes * (long)MinuteMs);
        Trim(_bars, b => b.StartMs, t - retention);
        Trim(_closedMinutes, b => b.StartMs, historyCutoff);
        PruneRepairedMinutes(historyCutoff);
        foreach (var regime in _regimes)
        {
            regime.TrimRangeZones(historyCutoff);
        }
    }

    private void StartSession(string sessionId, long openMs, long? partialSinceMs)
    {
        _sessionId = sessionId;
        // The session profile is wiped below. Close the hole on the rolling profiles first, so it can expire
        // with their windows instead of staying open for the rest of the day.
        CloseOpenGap(gatewayMs: null, sourceMs: openMs);
        DropRepairsBefore(openMs);
        _cvdKnown = true;
        _orderFlow.StartSession(openMs, partialSinceMs);
        _vwap.Reset(sessionId, partialSinceMs is not null);
        _sessionProfile.ResetSession(sessionId, partialSinceMs);
        _cumulativeDelta = 0;
        _sessionDelta.Clear();
        _sessionVolume = 0;
        _sessionOpen = null;
        _sessionHigh = null;
        _sessionLow = null;
    }

    /// <summary>A repair for the previous session must not land in the new session profile or VWAP.</summary>
    private void DropRepairsBefore(long openMs)
    {
        _gaps.RemoveAll(span => span.SinceMs < openMs);
        _repairedMinutes.RemoveWhere(start => start < openMs);
        for (var i = _retiredRepairs.Count - 1; i >= 0; i--)
        {
            var range = _retiredRepairs[i];
            if (range.EndMs <= openMs)
            {
                _retiredRepairs.RemoveAt(i);
            }
            else if (range.StartMs < openMs)
            {
                _retiredRepairs[i] = (openMs, range.EndMs);
            }
        }

        var pending = false;
        foreach (var span in _gaps)
        {
            if (!span.Complete)
            {
                pending = true;
                break;
            }
        }

        if (!pending)
        {
            _repairArmed = false;
            _repairKick = false;
        }
    }

    private StatusDto StatusLocked()
    {
        var age = _lastReceivedMs == long.MinValue ? (long?)null : Math.Max(0, _nowMs - _lastReceivedMs);
        var instant = DateTimeOffset.FromUnixTimeMilliseconds(_nowMs);
        var stale = StaleLocked();
        var healthy = _provenance switch
        {
            FeedProvenance.Live => "LIVE",
            FeedProvenance.Replay => "REPLAY",
            FeedProvenance.Simulated => "SIMULATED",
            _ => throw new InvalidOperationException("Unknown provenance."),
        };
        var code = RecoveringLocked()
            ? "RECOVERING"
            : stale
                ? "STALE"
                : _missingSinceMs is not null || _repairArmed || SessionHoldsApproximateRepair()
                    ? "DEGRADED"
                    : healthy;
        return new StatusDto
        {
            Code = code,
            Provenance = _provenance.ToString().ToUpperInvariant(),
            Connected = _connected,
            BookKnown = _book.IsKnown,
            DepthSubscribed = _depthSubscribed,
            Epoch = _epoch,
            LastEventAgeMs = age,
            CoveredLow = _book.CoveredLow,
            CoveredHigh = _book.CoveredHigh,
            LevelsPerSide = _book.LevelsPerSide,
            SessionId = _sessionId ?? _calendar.SessionFor(instant).Id,
            ExchangeOpen = _calendar.IsOpen(instant),
            RecentCoverage = RecentCoverage(),
            DroppedWhileUnknown = _book.DroppedWhileUnknown,
            DuplicateTrades = _dedup.Duplicates,
            RejectedEvents = _rejected,
            ClockAheadRejectedEvents = _rejectedClockAhead,
            BookResets = _resets,
            MissingSinceMs = _missingSinceMs,
            CvdKnown = _cvdKnown,
            Approximate = SessionHoldsApproximateRepair(),
        };
    }

    /// <summary>RECOVERING in <see cref="StatusLocked"/>: disconnected, or depth subscribed with the book unknown.</summary>
    private bool RecoveringLocked() => !_connected || (_depthSubscribed && !_book.IsKnown);

    /// <summary>STALE in <see cref="StatusLocked"/>: connected, the exchange open, and no event for the stale window.</summary>
    private bool StaleLocked() =>
        _connected
        && _lastReceivedMs != long.MinValue
        && _nowMs - _lastReceivedMs > _options.StaleAfterMs
        && _calendar.IsOpen(DateTimeOffset.FromUnixTimeMilliseconds(_nowMs));

    /// <summary>
    /// The tape reading, with no state while the feed is RECOVERING or STALE, where a quiet tape cannot be told from a
    /// silent feed, or while the exchange is closed, where the tape is shut rather than thin (REQUIREMENTS.md FR-83).
    /// </summary>
    private TapeReading TapeLocked()
    {
        var reading = _tape.Reading();
        return RecoveringLocked() || StaleLocked() || !_calendar.IsOpen(DateTimeOffset.FromUnixTimeMilliseconds(_nowMs))
            ? reading with { State = TapeState.Unknown, BaselineRate = null, ThinBelowRate = null }
            : reading;
    }

    /// <summary>Rolling profiles keep their flags until they expire. Only the session profile holds the contract DEGRADED.</summary>
    private bool SessionHoldsApproximateRepair() => _sessionProfile.ApproximateRanges.Count > 0;

    private double RecentCoverage()
    {
        var recent = _heat.TakeLast(10).ToList();
        if (recent.Count == 0)
        {
            return 0;
        }

        var span = _book.LevelsPerSide > 0 ? Math.Max(1, recent.Max(c => c.Cells.Count)) : 1;
        var known = recent.Sum(c => c.Cells.Sum(cell => (double)cell.KnownMs));
        return Math.Clamp(known / (recent.Count * (double)_options.SliceMs * span), 0, 1);
    }

    private OrderFlowDto OrderFlowLocked(
        IReadOnlyList<FootprintBar> footprints,
        IReadOnlyList<(long EndMs, long Cvd)> cvd,
        IReadOnlyList<OrderFlowSignal> signals) => new()
        {
            Cvd = _orderFlow.Cvd,
            CvdPoints = cvd.Select(p => (IReadOnlyList<long>)[p.EndMs, p.Cvd]).ToList(),
            Footprints = footprints.Where(f => !f.IsEmpty).Select(ToDto).ToList(),
            DevelopingFootprint = _orderFlow.DevelopingFootprint is { IsEmpty: false } dev ? ToDto(dev) : null,
            Signals = signals,
            LastSignalId = _orderFlow.Signals.LastId,
            Icebergs = _orderFlow.Icebergs,
            Zones = _orderFlow.Zones.ToList(),
            UnfinishedAuctions = _orderFlow.UnfinishedAuctions.ToList(),
            KeyLevels = _orderFlow.KeyLevels(),
            Tpo = _orderFlow.Tpo,
            FootprintSeconds = _options.OrderFlow.FootprintSeconds,
        };

    private FootprintDto ToDto(FootprintBar bar)
    {
        var flags = FootprintAnalysis.ImbalanceFlags(bar, _options.OrderFlow.ImbalanceRatio, _options.OrderFlow.ImbalanceMinVolume);
        var cells = bar.Cells;
        var flat = new List<long>(cells.Count * 4);
        foreach (var cell in cells)
        {
            flat.Add(cell.PriceTicks);
            flat.Add(cell.BidVolume);
            flat.Add(cell.AskVolume);
            flat.Add(flags.TryGetValue(cell.PriceTicks, out var f) ? f : 0);
        }

        var missing = BarIsMissing(bar.StartMs, bar.EndMs);
        var approximate = BarIsApproximate(bar.StartMs, bar.EndMs);
        return new FootprintDto(
            bar.StartMs,
            bar.DurationMs,
            bar.Open,
            bar.High,
            bar.Low,
            bar.Close,
            bar.Volume,
            bar.Delta,
            bar.MaxDelta,
            bar.MinDelta,
            flat,
            missing && !approximate,
            approximate);
    }

    // Called by the order-flow layer under the engine's lock.
    private List<KeyLevel> ExternalLevels()
    {
        var levels = new List<KeyLevel>(4);
        if (_vwap.Value is { } v)
        {
            levels.Add(new KeyLevel("VWAP", (long)Math.Round(v.Vwap), IsHigh: false));
        }

        if (_sessionProfile.Snapshot().ValueArea is { } va)
        {
            levels.Add(new KeyLevel("POC", va.PocTicks, IsHigh: false));
            levels.Add(new KeyLevel("VAH", va.HighTicks, IsHigh: true));
            levels.Add(new KeyLevel("VAL", va.LowTicks, IsHigh: false));
        }

        return levels;
    }

    /// <summary>The compact quote a tab shows without subscribing to the book.</summary>
    public InstrumentQuote Quote()
    {
        lock (_gate)
        {
            var touches = TouchesLocked();
            var last = _lastPrice;
            LevelTouch? nearest = null;
            if (last is { } price && touches.Count > 0)
            {
                nearest = touches.MinBy(level => Math.Abs(level.PriceTicks - price));
            }

            var vwap = _vwap.Value;
            return new InstrumentQuote(
                Info,
                StatusLocked(),
                last,
                _sessionOpen,
                last is { } px && _sessionOpen is { } open ? px - open : null,
                vwap?.Vwap,
                vwap?.StdDev,
                nearest?.Name,
                last is { } at && nearest is not null ? at - nearest.PriceTicks : null,
                nearest?.Touches ?? 0,
                nearest?.IsThirdTouch ?? false,
                touches);
        }
    }

    private void FoldHeat(HeatmapColumn column)
    {
        var minute = column.StartMs - (column.StartMs % MinuteMs);
        if (_openMinuteStart != long.MinValue && minute != _openMinuteStart)
        {
            _minuteHeat.Add(HeatmapColumn.Combine(_openMinuteStart, MinuteMs, _openMinuteHeat));
            _openMinuteHeat.Clear();
        }

        _openMinuteStart = minute;
        _openMinuteHeat.Add(column);
    }

    private HeatColumnDto? OpenMinuteHeat(long fromMs)
    {
        if (_openMinuteHeat.Count == 0 || _openMinuteStart < fromMs)
        {
            return null;
        }

        var duration = (int)Math.Clamp(_nowMs - _openMinuteStart, 1, MinuteMs);
        return ToDto(HeatmapColumn.Combine(_openMinuteStart, duration, _openMinuteHeat));
    }

    private void SetEpoch(long epoch)
    {
        if (epoch != _printsEpoch)
        {
            _prints.Clear();
            _printsEpoch = epoch;
            _publishedPrintSequence = _printSequence;
        }

        _epoch = epoch;
    }

    /// <summary>Live tape only. History warmup has no aggressor side (REQUIREMENTS.md FR-61, ARCHITECTURE.md D-15).</summary>
    private void RememberPrint(TradeEvent trade)
    {
        _printSequence++;
        _prints.Add(new PrintDto
        {
            SourceTimeMs = trade.SourceTimeMs,
            PriceTicks = trade.PriceTicks,
            Quantity = trade.Quantity,
            Aggressor = trade.Aggressor.ToString(),
            Sequence = _printSequence,
        });
        var cap = Math.Max(1, _options.PrintCapacity);
        var overflow = _prints.Count - cap;
        if (overflow > 0)
        {
            _prints.RemoveRange(0, overflow);
        }
    }

    private List<PrintDto> PrintsSincePublished()
    {
        var fresh = new List<PrintDto>();
        foreach (var print in _prints)
        {
            if (print.Sequence > _publishedPrintSequence)
            {
                fresh.Add(print);
            }
        }

        if (fresh.Count > 0)
        {
            _publishedPrintSequence = fresh[^1].Sequence;
        }

        return fresh;
    }

    private void KeepMinute(TradeBar minute)
    {
        _closedMinutes.Add(minute);
        ObserveRips(minute);
    }

    private void ObserveRips(TradeBar minute)
    {
        if (minute.Open is { } open && minute.High is { } high && minute.Low is { } low)
        {
            _rips.Observe(Spec, _calendar, new MinuteRange(minute.StartMs, minute.EndMs, open, high, low));
        }
    }

    private void NoteTop(MarketEvent marketEvent)
    {
        _topOfBookMs = marketEvent.SourceTimeMs;
        _topReceivedMs = marketEvent.ReceivedTimeMs;
    }

    private IReadOnlyList<KeyLevel> RipsLevelsLocked()
    {
        if (_lastMarketMs == long.MinValue)
        {
            return [];
        }

        MinuteRange? developing = _minuteBars.Current is { IsEmpty: false, Open: { } open, High: { } high, Low: { } low } bar
            ? new MinuteRange(bar.StartMs, bar.EndMs, open, high, low)
            : null;
        return _rips.Levels(Spec, _calendar, DateTimeOffset.FromUnixTimeMilliseconds(_lastMarketMs), developing);
    }

    private List<LevelTouch> TouchesLocked()
    {
        var bars = new List<(long TimeMs, long Low, long High, long? Close)>();
        foreach (var bar in _closedMinutes)
        {
            if (bar.Low is { } low && bar.High is { } high)
            {
                bars.Add((bar.StartMs, low, high, bar.Close));
            }
        }

        // The developing minute can make a touch but has not closed, so it cannot break a level (FR-79).
        if (_minuteBars.Current is { IsEmpty: false, Low: { } developingLow, High: { } developingHigh } developing)
        {
            bars.Add((developing.StartMs, developingLow, developingHigh, null));
        }

        var levels = new List<(string Name, long Price, bool IsHigh, string? SessionId, long? AsOfMs)>();
        if (_sessionHigh is { } sessionHigh)
        {
            levels.Add(("Session high", sessionHigh, true, null, null));
        }

        if (_sessionLow is { } sessionLow)
        {
            levels.Add(("Session low", sessionLow, false, null, null));
        }

        foreach (var level in ExternalLevels())
        {
            levels.Add((level.Name, level.PriceTicks, level.IsHigh, level.SessionId, level.AsOfMs));
        }

        foreach (var level in RipsLevelsLocked())
        {
            levels.Add((level.Name, level.PriceTicks, level.IsHigh, level.SessionId, level.AsOfMs));
        }

        var proximity = Math.Max(0, _options.OrderFlow.KeyLevelProximityTicks);
        return levels.Select(level => LevelTouchCounter.Count(
            level.Name, level.Price, level.IsHigh, bars, proximity, level.SessionId, level.AsOfMs)).ToList();
    }

    private List<IndicatorSeries> AllIndicators(bool full)
    {
        var series = new List<IndicatorSeries>();
        foreach (var engine in _indicatorEngines)
        {
            series.AddRange(full ? engine.Series() : engine.SeriesSince(_publishedIndicatorMs));
        }

        return series;
    }

    private long LatestIndicatorMs()
    {
        var latest = long.MinValue;
        foreach (var engine in _indicatorEngines)
        {
            latest = Math.Max(latest, engine.LatestPointMs);
        }

        return latest;
    }

    private void AddIndicatorTrade(long timeMs, long priceTicks, long quantity, bool buyer)
    {
        foreach (var engine in _indicatorEngines)
        {
            engine.AddTrade(timeMs, priceTicks, quantity, buyer);
        }
    }

    private void AdvanceIndicators(long timeMs)
    {
        foreach (var engine in _indicatorEngines)
        {
            engine.AdvanceTo(timeMs);
        }
    }

    /// <summary>The configured periods, all read on one viewer timeframe.</summary>
    private static IndicatorSettings AtTimeframe(IndicatorSettings source, int timeframeSeconds) => new()
    {
        Emas = source.Emas.Select(ema => ema with { TimeframeSeconds = timeframeSeconds }).ToList(),
        Rsi = source.Rsi with { TimeframeSeconds = timeframeSeconds },
        Macd = source.Macd with { TimeframeSeconds = timeframeSeconds },
        Atr = source.Atr with { TimeframeSeconds = timeframeSeconds },
    };

    private List<ProfileDto> ProfilesLocked() =>
    [
        ToDto(_sessionProfile.Snapshot()),
        ToDto(_profile1h.Snapshot()),
        ToDto(_profile4h.Snapshot()),
        ToDto(_profile5d.Snapshot()),
    ];

    private VwapDto VwapLocked() =>
        _vwap.Value is { } v
            ? new VwapDto(v.Vwap, v.StdDev, v.Volume, _vwap.IsPartial, _vwap.AnchorId)
            : new VwapDto(null, null, 0, _vwap.IsPartial, _vwap.AnchorId);

    private LiquiditySnapshot LiquidityLocked()
    {
        var bid = _book.IsKnown ? _book.BestBid : _quoteBid;
        var ask = _book.IsKnown ? _book.BestAsk : _quoteAsk;
        var bidQty = _book.IsKnown && bid is { } b ? _book.QuantityAt(BookSide.Bid, b) : null;
        var askQty = _book.IsKnown && ask is { } a ? _book.QuantityAt(BookSide.Ask, a) : null;
        double? micro = bid is { } bb && ask is { } aa && bidQty is { } bq && askQty is { } aq && bq + aq > 0
            ? ((bb * (double)aq) + (aa * (double)bq)) / (bq + aq)
            : null;
        var cutoff10 = _nowMs - 10_000;
        return new LiquiditySnapshot
        {
            BookKnown = _book.IsKnown,
            BestBid = bid,
            BestAsk = ask,
            BestBidQuantity = bidQty,
            BestAskQuantity = askQty,
            QuoteTimeMs = _topOfBookMs,
            QuoteStale = !_connected || _topReceivedMs is not long received || _nowMs - received > _options.StaleAfterMs,
            SpreadTicks = bid is { } sb && ask is { } sa ? sa - sb : null,
            Microprice = micro,
            Depth = _book.IsKnown
                ? DepthLevels.Select(n => new DepthReading(n, _book.DepthAt(BookSide.Bid, n) ?? 0, _book.DepthAt(BookSide.Ask, n) ?? 0)).ToList()
                : [],
            Flow10s = _flows.Totals(_nowMs, 10_000),
            Flow60s = _flows.Totals(_nowMs, 60_000),
            CumulativeDelta = _cumulativeDelta,
            Delta60s = _recentTrades.Sum(t => t.Delta),
            TradeRate = _recentTrades.Where(t => t.TimeMs > cutoff10).Sum(t => t.Quantity) / 10.0,
            Tape = TapeLocked(),
            SessionVolume = _sessionVolume,
            Walls = _walls.Detect(_nowMs, _book),
            EndedWalls = _walls.Ended(_nowMs),
        };
    }

    private LadderDto LadderLocked() => new(
        _book.Bids.Take(_options.LadderLevels).Select(l => (IReadOnlyList<long>)[l.Key, l.Value]).ToList(),
        _book.Asks.Take(_options.LadderLevels).Select(l => (IReadOnlyList<long>)[l.Key, l.Value]).ToList());

    private static List<T> NewSince<T>(List<T> items, Func<T, long> key, long afterMs)
    {
        var start = items.Count;
        while (start > 0 && key(items[start - 1]) > afterMs)
        {
            start--;
        }

        return items.GetRange(start, items.Count - start);
    }

    private List<RangeZoneSetDto> RangeZonesLocked() => _regimes.Select(r => r.RangeZoneSet()).ToList();

    private long RangeZoneVersionLocked() => _regimes.Sum(r => r.RangeZoneVersion);

    private static void Trim<T>(List<T> items, Func<T, long> key, long beforeMs)
    {
        var remove = 0;
        while (remove < items.Count && key(items[remove]) < beforeMs)
        {
            remove++;
        }

        if (remove > 0)
        {
            items.RemoveRange(0, remove);
        }
    }

    private static HeatColumnDto ToDto(HeatmapColumn column)
    {
        var flat = new List<double>(column.Cells.Count * 4);
        foreach (var cell in column.Cells)
        {
            flat.Add(cell.PriceTicks);
            flat.Add(Math.Round(cell.BidTimeWeighted ?? 0, 1));
            flat.Add(Math.Round(cell.AskTimeWeighted ?? 0, 1));
            flat.Add(cell.KnownMs);
        }

        return new HeatColumnDto(column.StartMs, column.DurationMs, flat);
    }

    private static BarDto ToDto(TradeBar bar) =>
        new(bar.StartMs, bar.DurationMs, bar.Open, bar.High, bar.Low, bar.Close, bar.Volume, bar.BuyVolume, bar.SellVolume, bar.TradeCount);

    private static IndicatorDto ToDto(IndicatorSeries series) => new()
    {
        Id = series.Id,
        Label = series.Label,
        Kind = series.Kind.ToString().ToLowerInvariant(),
        Tf = series.TimeframeSeconds,
        Warmup = series.WarmupBars,
        Seen = series.SeenBars,
        Ready = series.Ready,
        Points = series.Points
            .Select(p => (IReadOnlyList<double?>)[p.TimeMs, .. p.Values.Select(Clean)])
            .ToList(),
        Dev = series.Developing?.Select(Clean).ToList(),
    };

    private static double? Clean(double value) => double.IsNaN(value) || double.IsInfinity(value) ? null : Math.Round(value, 4);

    private ProfileDto ToDto(ProfileSnapshot profile) => new()
    {
        Window = profile.Window,
        Bins = profile.Bins.Select(b => (IReadOnlyList<long>)[b.Key, b.Value]).ToList(),
        Total = profile.TotalVolume,
        Poc = profile.ValueArea?.PocTicks,
        Vah = profile.ValueArea?.HighTicks,
        Val = profile.ValueArea?.LowTicks,
        VaFraction = profile.ValueArea is { } va ? Math.Round(va.Fraction, 4) : null,
        PartialSinceMs = profile.PartialSinceMs,
        MissingRanges = profile.MissingRanges.Select(range => (IReadOnlyList<long?>)[range.SinceMs, range.UntilMs]).ToList(),
        ApproximateRanges = profile.ApproximateRanges.Select(range => (IReadOnlyList<long?>)[range.SinceMs, range.UntilMs]).ToList(),
        Hvn = ProfileNodes.Find(profile.Bins, _options.OrderFlow).Where(n => n.IsHigh).Select(n => n.PriceTicks).ToList(),
        Lvn = ProfileNodes.Find(profile.Bins, _options.OrderFlow).Where(n => !n.IsHigh).Select(n => n.PriceTicks).ToList(),
    };

    private OverlayDto? ToDto(Overlay? overlay) => overlay is null
        ? null
        : new OverlayDto
        {
            Version = overlay.Request.Version,
            Publisher = overlay.Publisher,
            GeneratedAtMs = overlay.Request.GeneratedAt.ToUnixTimeMilliseconds(),
            AsOfMs = overlay.Request.AsOf.ToUnixTimeMilliseconds(),
            ExpiresAtMs = overlay.Request.ExpiresAt.ToUnixTimeMilliseconds(),
            AvailableAtMs = overlay.AvailableAt.ToUnixTimeMilliseconds(),
            Expired = overlay.Request.ExpiresAt.ToUnixTimeMilliseconds() <= _nowMs,
            SourceCoverage = overlay.Request.SourceCoverage,
            Levels = overlay.Request.Levels
                .Select(l => new OverlayLevelDto(Spec.ToTicks(l.Price), l.Price, l.Label, l.Kind))
                .ToList(),
            Rationale = overlay.Request.Rationale,
            QualityFlags = overlay.Request.QualityFlags,
        };

    /// <summary>One dropped-trade hole. An open hole has no <see cref="UntilMs"/>.</summary>
    private sealed class GapSpan
    {
        public long SinceMs { get; set; }

        public long? UntilMs { get; set; }

        public bool Complete { get; set; }
    }
}
