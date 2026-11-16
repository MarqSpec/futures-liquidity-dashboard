using MarqSpec.FuturesLiquidityDashboard.Core.Bars;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

public enum IndicatorKind
{
    Ema,
    Rsi,
    Macd,
    Atr,
}

/// <summary>A closed indicator value, stamped with the close time of the source bar it used (REQUIREMENTS.md FR-17, FR-26).</summary>
public sealed record IndicatorPoint(long TimeMs, IReadOnlyList<double> Values);

/// <summary>The state of one indicator: closed history, readiness and an optional developing value.</summary>
public sealed record IndicatorSeries
{
    public required string Id { get; init; }

    public required string Label { get; init; }

    public required IndicatorKind Kind { get; init; }

    public required int TimeframeSeconds { get; init; }

    /// <summary>Closed source bars needed before the first value (warmup).</summary>
    public required int WarmupBars { get; init; }

    public required int SeenBars { get; init; }

    public required bool Ready { get; init; }

    public required IReadOnlyList<IndicatorPoint> Points { get; init; }

    /// <summary>Provisional values from the forming source bar; marked developing and never part of closed history.</summary>
    public IReadOnlyList<double>? Developing { get; init; }
}

/// <summary>
/// Runs every indicator on its own source timeframe from executed trades (ARCHITECTURE.md, Indicator engine).
/// Changing the display interval or the visible window never touches it (REQUIREMENTS.md FR-2). Not thread-safe.
/// </summary>
public sealed class IndicatorEngine
{
    private readonly Dictionary<int, BarAggregator> _aggregators = [];
    private readonly List<Track> _tracks = [];
    private readonly int _maxPoints;

    public IndicatorEngine(IndicatorSettings settings, int maxPoints = 720)
    {
        ArgumentNullException.ThrowIfNull(settings);
        _maxPoints = maxPoints;
        foreach (var ema in settings.Emas)
        {
            var e = new Ema(ema.Period);
            AddTrack($"ema{ema.Period}", $"EMA {ema.Period}", IndicatorKind.Ema, ema.TimeframeSeconds, ema.Period,
                b => e.Update(b.Close) is { } v ? [v] : null,
                (b, _) => e.Developing(b.Close) is { } v ? [v] : null);
        }

        var rsi = new Rsi(settings.Rsi.Period);
        AddTrack($"rsi{settings.Rsi.Period}", $"RSI {settings.Rsi.Period}", IndicatorKind.Rsi, settings.Rsi.TimeframeSeconds,
            settings.Rsi.Period + 1,
            b => rsi.Update(b.Close) is { } v ? [v] : null,
            (b, _) => rsi.Developing(b.Close) is { } v ? [v] : null);

        var m = settings.Macd;
        var macd = new Macd(m.Fast, m.Slow, m.Signal);
        AddTrack("macd", $"MACD {m.Fast}/{m.Slow}/{m.Signal}", IndicatorKind.Macd, m.TimeframeSeconds, m.Slow + m.Signal - 1,
            b => macd.Update(b.Close) is { } v ? [v.Line, v.Signal ?? double.NaN, v.Histogram ?? double.NaN] : null,
            (b, _) => macd.Developing(b.Close) is { } v ? [v.Line, v.Signal ?? double.NaN, v.Histogram ?? double.NaN] : null);

        var atr = new Atr(settings.Atr.Period);
        AddTrack($"atr{settings.Atr.Period}", $"ATR {settings.Atr.Period}", IndicatorKind.Atr, settings.Atr.TimeframeSeconds,
            settings.Atr.Period,
            b => atr.Update(b.High, b.Low, b.Close) is { } v ? [v] : null,
            (b, _) => atr.Developing(b.High, b.Low) is { } v ? [v] : null);
    }

    /// <summary>Feeds one execution; closes any source bars it ends.</summary>
    public void AddTrade(long timeMs, long priceTicks, long quantity, bool buyerAggressor)
    {
        foreach (var (timeframe, aggregator) in _aggregators)
        {
            Apply(timeframe, aggregator.Add(timeMs, priceTicks, quantity, buyerAggressor));
        }
    }

    /// <summary>Closes source bars that ended by <paramref name="timeMs"/> even without a trade.</summary>
    public void AdvanceTo(long timeMs)
    {
        foreach (var (timeframe, aggregator) in _aggregators)
        {
            Apply(timeframe, aggregator.AdvanceTo(timeMs));
        }
    }

    public IReadOnlyList<IndicatorSeries> Series(bool includeDeveloping = true) =>
        _tracks.Select(t => t.ToSeries(includeDeveloping ? Forming(t.TimeframeSeconds) : null)).ToList();

    /// <summary>Closed points newer than <paramref name="afterMs"/>, per indicator, with the current developing value.</summary>
    public IReadOnlyList<IndicatorSeries> SeriesSince(long afterMs) =>
        _tracks.Select(t => t.ToSeries(Forming(t.TimeframeSeconds), afterMs)).ToList();

    /// <summary>The time of the newest closed point of any indicator, or <see cref="long.MinValue"/> when there is none.</summary>
    public long LatestPointMs
    {
        get
        {
            var latest = long.MinValue;
            foreach (var track in _tracks)
            {
                latest = Math.Max(latest, track.LastTimeMs);
            }

            return latest;
        }
    }

    /// <summary>The latest closed value of an indicator, or null when unready.</summary>
    public IReadOnlyList<double>? Latest(string id) =>
        _tracks.FirstOrDefault(t => t.Id == id)?.Points.LastOrDefault()?.Values;

    private TradeBar? Forming(int timeframeSeconds) =>
        _aggregators.TryGetValue(timeframeSeconds, out var a) && a.Current is { IsEmpty: false } bar ? bar : null;

    private void AddTrack(string id, string label, IndicatorKind kind, int timeframeSeconds, int warmup,
        Func<ClosedBar, double[]?> update, Func<ClosedBar, bool, double[]?> developing)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(timeframeSeconds, 1);
        if (!_aggregators.ContainsKey(timeframeSeconds))
        {
            _aggregators[timeframeSeconds] = new BarAggregator(timeframeSeconds * 1000);
        }

        _tracks.Add(new Track(id, label, kind, timeframeSeconds, warmup, update, developing, _maxPoints));
    }

    private void Apply(int timeframe, IReadOnlyList<TradeBar> closed)
    {
        foreach (var bar in closed.Where(b => !b.IsEmpty))
        {
            var cb = ClosedBar.From(bar);
            foreach (var track in _tracks.Where(t => t.TimeframeSeconds == timeframe))
            {
                track.Close(bar.EndMs, cb);
            }
        }
    }

    private readonly record struct ClosedBar(double High, double Low, double Close)
    {
        public static ClosedBar From(TradeBar bar) =>
            new(bar.High ?? double.NaN, bar.Low ?? double.NaN, bar.Close ?? double.NaN);
    }

    private sealed class Track(
        string id,
        string label,
        IndicatorKind kind,
        int timeframeSeconds,
        int warmup,
        Func<ClosedBar, double[]?> update,
        Func<ClosedBar, bool, double[]?> developing,
        int maxPoints)
    {
        private readonly Queue<IndicatorPoint> _points = new();
        private int _seen;

        public string Id { get; } = id;

        public int TimeframeSeconds { get; } = timeframeSeconds;

        public IReadOnlyCollection<IndicatorPoint> Points => _points;

        /// <summary>The newest point's time, or <see cref="long.MinValue"/> before the first.</summary>
        public long LastTimeMs { get; private set; } = long.MinValue;

        public void Close(long timeMs, ClosedBar bar)
        {
            _seen++;
            if (update(bar) is { } values)
            {
                _points.Enqueue(new IndicatorPoint(timeMs, values));
                LastTimeMs = timeMs;
                while (_points.Count > maxPoints)
                {
                    _points.Dequeue();
                }
            }
        }

        public IndicatorSeries ToSeries(TradeBar? forming, long afterMs = long.MinValue) => new()
        {
            Id = Id,
            Label = label,
            Kind = kind,
            TimeframeSeconds = TimeframeSeconds,
            WarmupBars = warmup,
            SeenBars = _seen,
            Ready = _points.Count > 0,
            Points = _points.Where(p => p.TimeMs > afterMs).ToList(),
            Developing = forming is null ? null : developing(ClosedBar.From(forming), true),
        };
    }
}
