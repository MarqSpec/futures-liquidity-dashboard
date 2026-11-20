using System.Globalization;
using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>
/// The order-flow layer of one instrument engine (REQUIREMENTS.md FR-41–FR-52): footprint bars, the bar-level delta
/// detectors, icebergs, spoofs, sweeps, the TPO profile, open unfinished auctions and active imbalance zones, and
/// the signal log they all write to. The engine feeds it every accepted trade and depth change in order; history
/// trades warm the bar detectors and the TPO profile, but the detectors that need the book (icebergs, spoofs) only
/// run on live data because depth is never backfilled. Not thread-safe: the engine's lock covers it.
/// </summary>
public sealed class OrderFlowAnalyzer
{
    private readonly OrderFlowOptions _options;
    private readonly FootprintAggregator _footprints;
    private readonly List<FootprintBar> _closed = [];
    private readonly BarFlowAnalyzer _bars;
    private readonly IcebergDetector _icebergs;
    private readonly SpoofDetector _spoofs;
    private readonly SweepDetector _sweeps;
    private readonly TpoProfile _tpo;
    private readonly List<UnfinishedAuction> _unfinished = [];
    private readonly List<ImbalanceZone> _zones = [];
    private readonly HashSet<(long Low, long High, char Letter)> _reportedSinglePrints = [];
    private long? _sessionHigh;
    private long? _sessionLow;
    private long? _priorHigh;
    private long? _priorLow;
    private long? _sessionOpenMs;
    private long? _lastPrice;
    private int _lastTpoPeriod = -1;

    /// <summary>Three days, the same default as <c>Engine:HistoryRetentionMinutes</c>. The engine passes the configured value.</summary>
    private const long DefaultSignalRetentionMs = 3L * 24 * 60 * 60_000;

    public OrderFlowAnalyzer(OrderFlowOptions options, int tpoRowTicks, long signalRetentionMs = DefaultSignalRetentionMs)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        ArgumentOutOfRangeException.ThrowIfNegative(signalRetentionMs);
        _footprints = new FootprintAggregator(Math.Max(1, options.FootprintSeconds) * 1000);
        _bars = new BarFlowAnalyzer(options);
        _icebergs = new IcebergDetector(options);
        _spoofs = new SpoofDetector(options);
        _sweeps = new SweepDetector(options);
        _tpo = new TpoProfile(options.TpoPeriodMinutes, tpoRowTicks);
        Signals = new SignalLog(signalRetentionMs, options.SignalHistoryCap);
    }

    public OrderFlowOptions Options => _options;

    public SignalLog Signals { get; }

    /// <summary>Levels the engine knows and this layer does not: VWAP and the value-area edges.</summary>
    public Func<IReadOnlyList<KeyLevel>> ExternalLevels { get; set; } = () => [];

    /// <summary>RIPS named levels (REQUIREMENTS.md FR-63). Empty unless the engine supplies them. Not watched as sweeps.</summary>
    public Func<IReadOnlyList<KeyLevel>> NamedLevels { get; set; } = () => [];

    public IReadOnlyList<FootprintBar> ClosedFootprints => _closed;

    public FootprintBar? DevelopingFootprint => _footprints.Current;

    public long Cvd => _bars.LiveCvd(_footprints.Current);

    /// <summary>
    /// Drops the session CVD series. A dropped trade has no known aggressor, so the gap is not entered as zero
    /// delta (ARCHITECTURE.md D-32). The next live bar starts the series again from zero.
    /// </summary>
    public void ResetCvdAnchor() => _bars.ResetSession();

    public IReadOnlyList<(long EndMs, long Cvd)> CvdSeries => _bars.CvdSeries;

    public IReadOnlyList<UnfinishedAuction> UnfinishedAuctions => _unfinished;

    public IReadOnlyList<ImbalanceZone> Zones => _zones;

    public IReadOnlyList<IcebergReading> Icebergs => _icebergs.Readings();

    public IReadOnlyList<KeyLevel> SweepLevels => _sweeps.Levels;

    public TpoSnapshot Tpo => _tpo.Snapshot(_options.SinglePrintMinRows);

    /// <summary>Key levels for proximity tests: prior session and session extremes, swing pivots, and the engine's levels.</summary>
    public IReadOnlyList<KeyLevel> KeyLevels()
    {
        var levels = new List<KeyLevel>();
        if (_priorHigh is { } ph)
        {
            // Dated at this session's open, so a print from an earlier session cannot breach it (REQUIREMENTS.md FR-65).
            levels.Add(new KeyLevel("prior session high", ph, IsHigh: true, AsOfMs: _sessionOpenMs));
        }

        if (_priorLow is { } pl)
        {
            levels.Add(new KeyLevel("prior session low", pl, IsHigh: false, AsOfMs: _sessionOpenMs));
        }

        if (_sessionHigh is { } sh)
        {
            levels.Add(new KeyLevel("session high", sh, IsHigh: true));
        }

        if (_sessionLow is { } sl)
        {
            levels.Add(new KeyLevel("session low", sl, IsHigh: false));
        }

        levels.AddRange(_bars.Pivots.TakeLast(6).Select(p => new KeyLevel(p.IsHigh ? "swing high" : "swing low", p.PriceTicks, p.IsHigh)));
        levels.AddRange(ExternalLevels());
        levels.AddRange(NamedLevels());
        return levels;
    }

    public void StartSession(long sessionOpenMs, long? partialSinceMs)
    {
        _priorHigh = _sessionHigh ?? _priorHigh;
        _priorLow = _sessionLow ?? _priorLow;
        _sessionHigh = null;
        _sessionLow = null;
        _bars.ResetSession();
        _tpo.Reset(sessionOpenMs, partialSinceMs);
        _reportedSinglePrints.Clear();
        _lastTpoPeriod = -1;
        _unfinished.Clear();
        _zones.Clear();
        _sweeps.Clear();
        _sessionOpenMs = sessionOpenMs;
        if (_priorHigh is { } high)
        {
            _sweeps.Watch(new KeyLevel("prior session high", high, IsHigh: true, AsOfMs: sessionOpenMs), _lastPrice);
        }

        if (_priorLow is { } low)
        {
            _sweeps.Watch(new KeyLevel("prior session low", low, IsHigh: false, AsOfMs: sessionOpenMs), _lastPrice);
        }
    }

    /// <param name="displayedResting">Resting size at the print's price on the passive side before the print, when the book is known.</param>
    public void OnTrade(long timeMs, long priceTicks, long quantity, bool buyerAggressor, long? displayedResting, bool live)
    {
        foreach (var bar in _footprints.Add(timeMs, priceTicks, quantity, buyerAggressor))
        {
            OnBarClosed(bar);
        }

        _tpo.Add(timeMs, priceTicks);
        _lastPrice = priceTicks;
        _unfinished.RemoveAll(u => u.AtHigh ? priceTicks > u.PriceTicks : priceTicks < u.PriceTicks);
        _zones.RemoveAll(z => z.Bias == SignalBias.Bullish ? priceTicks < z.LowTicks : priceTicks > z.HighTicks);

        if (_options.EnableSweeps)
        {
            foreach (var sweep in _sweeps.OnTrade(timeMs, priceTicks, quantity))
            {
                var strength = Math.Min(1, 0.4 + (Math.Abs(sweep.ExtremeTicks - sweep.Level.PriceTicks) / 8.0));
                Signals.Add(SignalKind.LiquiditySweep, sweep.Level.IsHigh ? SignalBias.Bearish : SignalBias.Bullish, timeMs,
                    sweep.Level.PriceTicks, sweep.ExtremeTicks, strength,
                    sweep.Level.IsHigh ? $"Inferred sweep above {sweep.Level.Name}" : $"Inferred sweep below {sweep.Level.Name}",
                    SweepDetector.Describe(sweep) + " Inferred from prints, not a confirmed stop run.");
            }
        }

        if (!live)
        {
            return;
        }

        var resting = buyerAggressor ? BookSide.Ask : BookSide.Bid;
        if (_options.EnableSpoofs)
        {
            _spoofs.OnTrade(timeMs, priceTicks, quantity, resting);
        }

        if (_options.EnableIcebergs && displayedResting is not null
            && _icebergs.OnTrade(timeMs, priceTicks, quantity, resting, displayedResting) is { } iceberg)
        {
            ReportIceberg(timeMs, iceberg);
        }
    }

    public void OnLevelChange(long timeMs, LevelChange change, OrderBook book)
    {
        if (_options.EnableIcebergs && _icebergs.OnLevelChange(timeMs, change) is { } iceberg)
        {
            ReportIceberg(timeMs, iceberg);
        }

        if (!_options.EnableSpoofs)
        {
            return;
        }

        _spoofs.OnBookMoved(book);
        if (_spoofs.OnLevelChange(timeMs, change, book) is { } spoof)
        {
            var bid = spoof.Side == BookSide.Bid;
            Signals.Add(SignalKind.Spoof, bid ? SignalBias.Bearish : SignalBias.Bullish, timeMs, spoof.PriceTicks, spoof.PriceTicks,
                Math.Min(1, (double)spoof.Pulled / Math.Max(1, spoof.PeakQuantity)),
                bid ? "Bid pulled on approach" : "Offer pulled on approach",
                string.Create(CultureInfo.InvariantCulture,
                    $"{spoof.PeakQuantity} resting for {spoof.RestedMs / 1000.0:0.#} s; {spoof.Pulled} cancelled, {spoof.Filled} traded; market {spoof.DistanceTicks} tick(s) away (was {spoof.FurthestTicks})"));
        }
    }

    /// <summary>The book is no longer known: anything that needs to see depth starts again.</summary>
    public void Invalidate()
    {
        _icebergs.Reset();
        _spoofs.Reset();
    }

    /// <summary>
    /// Puts an approximate footprint into the minute that starts at <paramref name="startMs"/>.
    /// Does not call <see cref="FootprintAggregator.Add"/> or <see cref="FootprintAggregator.AdvanceTo"/>:
    /// an older timestamp would land in the live bar. An existing non-empty bar is left alone.
    /// Returns false when the minute is the forming bar, ahead of it, or already has live prints.
    /// </summary>
    public bool PlaceApproximateMinute(long startMs, long openTicks, long highTicks, long lowTicks, long closeTicks, long volume)
    {
        if (_footprints.IntervalMs != 60_000 || volume <= 0)
        {
            return false;
        }

        if (_footprints.Current is { } current && startMs >= current.StartMs)
        {
            return false;
        }

        var bar = new FootprintBar(startMs, 60_000);
        // Odd lots alternate sides so the bar's net delta stays within one contract. That remainder is the
        // split, not aggressor flow, and this method does not move CVD (D-33).
        var oddLotToBuy = false;
        foreach (var (price, quantity) in SplitPrices(openTicks, highTicks, lowTicks, closeTicks, volume))
        {
            var buy = quantity / 2;
            var sell = quantity - buy;
            if ((quantity & 1) == 1)
            {
                if (oddLotToBuy)
                {
                    sell = quantity / 2;
                    buy = quantity - sell;
                }

                oddLotToBuy = !oddLotToBuy;
            }

            if (buy > 0)
            {
                bar.Add(price, buy, buyerAggressor: true);
            }

            if (sell > 0)
            {
                bar.Add(price, sell, buyerAggressor: false);
            }
        }

        var index = -1;
        for (var i = 0; i < _closed.Count; i++)
        {
            if (_closed[i].StartMs == startMs)
            {
                index = i;
                break;
            }
        }

        if (index >= 0)
        {
            if (!_closed[index].IsEmpty)
            {
                return false;
            }

            _closed[index] = bar;
            return true;
        }

        var at = _closed.FindIndex(existing => existing.StartMs > startMs);
        if (at < 0)
        {
            _closed.Add(bar);
        }
        else
        {
            _closed.Insert(at, bar);
        }

        while (_closed.Count > Math.Max(1, _options.FootprintRetentionBars))
        {
            _closed.RemoveAt(0);
        }

        return true;
    }

    /// <summary>Distinct OHLC prices, the bar's volume spread across them. The close keeps the remainder.</summary>
    internal static IReadOnlyList<(long Price, long Quantity)> SplitPrices(long open, long high, long low, long close, long volume)
    {
        if (volume <= 0)
        {
            return [];
        }

        var order = new[] { close, open, high, low };
        var seen = new List<long>(4);
        foreach (var price in order)
        {
            if (!seen.Contains(price))
            {
                seen.Add(price);
            }
        }

        var quantities = new long[seen.Count];
        var remaining = volume;
        for (var i = 0; i < seen.Count && remaining > 0; i++)
        {
            quantities[i] = 1;
            remaining--;
        }

        var share = seen.Count == 0 ? 0 : remaining / seen.Count;
        var extra = seen.Count == 0 ? 0 : remaining % seen.Count;
        for (var i = 0; i < seen.Count; i++)
        {
            quantities[i] += share + (i < extra ? 1 : 0);
        }

        var split = new List<(long, long)>(seen.Count);
        for (var i = 0; i < seen.Count; i++)
        {
            if (quantities[i] > 0)
            {
                split.Add((seen[i], quantities[i]));
            }
        }

        return split;
    }

    public void Advance(long timeMs)
    {
        foreach (var bar in _footprints.AdvanceTo(timeMs))
        {
            OnBarClosed(bar);
        }

        _icebergs.Expire(timeMs);
        _spoofs.Expire(timeMs);
        Signals.Prune(timeMs);
        var period = _tpo.PeriodOf(timeMs);
        if (period > _lastTpoPeriod)
        {
            if (_lastTpoPeriod >= 0)
            {
                ReportSinglePrints(timeMs);
            }

            _lastTpoPeriod = period;
        }
    }

    private void RememberClosed(FootprintBar bar)
    {
        _closed.Add(bar);
        while (_closed.Count > Math.Max(1, _options.FootprintRetentionBars))
        {
            _closed.RemoveAt(0);
        }
    }

    private void OnBarClosed(FootprintBar bar)
    {
        RememberClosed(bar);

        if (bar.IsEmpty)
        {
            return;
        }

        var levels = KeyLevels();
        var result = _bars.OnBarClosed(bar, levels);
        foreach (var (kind, bias, low, high, strength, label, detail) in result.Signals)
        {
            Signals.Add(kind, bias, bar.EndMs, low, high, strength, label, detail);
        }

        foreach (var pivot in result.NewPivots)
        {
            _sweeps.Watch(new KeyLevel(pivot.IsHigh ? "swing high" : "swing low", pivot.PriceTicks, pivot.IsHigh), _lastPrice);
        }

        if (_options.EnableStackedImbalances)
        {
            foreach (var zone in FootprintAnalysis.StackedImbalances(bar, _options.ImbalanceRatio, _options.ImbalanceMinVolume, _options.StackedMinLevels))
            {
                _zones.Add(zone);
                var strength = ((zone.Levels - _options.StackedMinLevels + 1) / 4.0)
                    + ((Math.Min(zone.AverageRatio, _options.ImbalanceRatio * 3) - _options.ImbalanceRatio) / (_options.ImbalanceRatio * 4));
                Signals.Add(SignalKind.StackedImbalance, zone.Bias, bar.EndMs, zone.LowTicks, zone.HighTicks, strength,
                    zone.Bias == SignalBias.Bullish ? "Stacked buy imbalance" : "Stacked sell imbalance",
                    string.Create(CultureInfo.InvariantCulture,
                        $"{zone.Levels} consecutive ticks at {zone.AverageRatio:0.0}× diagonal ({_options.ImbalanceRatio:0.#}× needed): {(zone.Bias == SignalBias.Bullish ? "demand" : "supply")} zone"));
            }

            while (_zones.Count > 20)
            {
                _zones.RemoveAt(0);
            }
        }

        if (_options.EnableUnfinishedAuctions)
        {
            _unfinished.AddRange(FootprintAnalysis.UnfinishedAuctions(bar));
            while (_unfinished.Count > 20)
            {
                _unfinished.RemoveAt(0);
            }
        }

        _sessionHigh = _sessionHigh is { } h ? Math.Max(h, bar.High!.Value) : bar.High;
        _sessionLow = _sessionLow is { } l ? Math.Min(l, bar.Low!.Value) : bar.Low;
    }

    private void ReportIceberg(long timeMs, IcebergReading iceberg)
    {
        var bid = iceberg.Side == BookSide.Bid;
        Signals.Add(SignalKind.Iceberg, bid ? SignalBias.Bullish : SignalBias.Bearish, timeMs, iceberg.PriceTicks, iceberg.PriceTicks,
            iceberg.Confidence, bid ? "Inferred bid iceberg" : "Inferred offer iceberg",
            string.Create(CultureInfo.InvariantCulture,
                $"{iceberg.Traded} traded against at most {iceberg.PeakDisplayed} shown, {iceberg.Refills} refills (avg {iceberg.AverageRefill}); hidden ≥ {iceberg.HiddenEstimate}. Inferred from prints and book changes, not exchange order ids."),
            iceberg.HiddenEstimate);
    }

    private void ReportSinglePrints(long timeMs)
    {
        if (!_options.EnableSinglePrints)
        {
            return;
        }

        foreach (var run in _tpo.Snapshot(_options.SinglePrintMinRows).SinglePrints.Where(r => !r.Tail))
        {
            if (_reportedSinglePrints.Add((run.LowTicks, run.HighTicks, run.Letter)))
            {
                var rows = ((run.HighTicks - run.LowTicks + 1) / _tpo.RowTicks);
                Signals.Add(SignalKind.SinglePrints, SignalBias.Neutral, timeMs, run.LowTicks, run.HighTicks, Math.Min(1, rows / 6.0),
                    string.Create(CultureInfo.InvariantCulture, $"Single prints ({run.Letter})"),
                    string.Create(CultureInfo.InvariantCulture, $"{rows} row(s) traded in period {run.Letter} only: an inefficiency the market often revisits"));
            }
        }
    }
}
