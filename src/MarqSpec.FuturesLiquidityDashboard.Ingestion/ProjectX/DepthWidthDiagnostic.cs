using System.Diagnostics.Metrics;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using Microsoft.Extensions.Logging;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

/// <summary>
/// Distinct bid and ask prices the ProjectX market hub has sent, counted before <c>LevelsPerSide</c> trimming
/// (REQUIREMENTS.md FR-11, FR-6). It does not subscribe, and it does not call an order, account or position route.
/// A price the gateway sets to zero is dropped. A reset clears the current book and keeps the high-water mark.
/// </summary>
public sealed partial class DepthWidthDiagnostic : IDisposable
{
    public const string Route = "/api/diagnostics/depth-width";

    /// <summary>Prices stored per side. Past this the max is a lower bound and <see cref="InstrumentDepthWidth.Capped"/> is set.</summary>
    public const int MaxPricesPerSide = 256;

    /// <summary>One sample a second, and the median uses only the most recent of these.</summary>
    public const int SampleRingCapacity = 256;

    public const long SampleIntervalMs = 1_000;

    public const long LogIntervalMs = 60_000;

    private readonly ILogger<DepthWidthDiagnostic> _logger;
    private readonly Meter _meter;
    private readonly int _levelsPerSide;
    private readonly int _ladderLevels;
    private readonly Lock _gate = new();
    private readonly Dictionary<InstrumentRoot, Series> _series = [];

    public DepthWidthDiagnostic(IMeterFactory meters, ILogger<DepthWidthDiagnostic> logger, int levelsPerSide, int ladderLevels)
    {
        ArgumentNullException.ThrowIfNull(meters);
        ArgumentNullException.ThrowIfNull(logger);
        _logger = logger;
        _levelsPerSide = levelsPerSide;
        _ladderLevels = ladderLevels;
        _meter = meters.Create(IngestMetrics.MeterName);
        _meter.CreateObservableGauge(
            "fld.depth.levels_per_side",
            () => (long)_levelsPerSide,
            description: "Configured Feed:ProjectX:LevelsPerSide. The snapshot keeps this many prices per side. Received depth is counted before that trim.");
        _meter.CreateObservableGauge(
            "fld.depth.ladder_levels",
            () => (long)_ladderLevels,
            description: "Configured Engine:LadderLevels. The ladder payload is cut to this many prices per side. It does not change the received count.");
        _meter.CreateObservableGauge("fld.depth.received_bids_max", () => Snapshot(static s => s.MaxBids), description: "Most distinct bid prices with size seen from the ProjectX market hub since this process started, before LevelsPerSide trim.");
        _meter.CreateObservableGauge("fld.depth.received_asks_max", () => Snapshot(static s => s.MaxAsks), description: "Most distinct ask prices with size seen from the ProjectX market hub since this process started, before LevelsPerSide trim.");
        _meter.CreateObservableGauge("fld.depth.received_bids_typical", () => SnapshotTypical(bids: true), description: "Lower median of distinct bid prices, one sample a second, the last 256 samples, before LevelsPerSide trim.");
        _meter.CreateObservableGauge("fld.depth.received_asks_typical", () => SnapshotTypical(bids: false), description: "Lower median of distinct ask prices, one sample a second, the last 256 samples, before LevelsPerSide trim.");
        _meter.CreateObservableGauge("fld.depth.received_bids", () => Snapshot(static s => s.Bids.Count), description: "Distinct bid prices in the untrimmed book now.");
        _meter.CreateObservableGauge("fld.depth.received_asks", () => Snapshot(static s => s.Asks.Count), description: "Distinct ask prices in the untrimmed book now.");
        _meter.CreateObservableGauge("fld.depth.received_capped", () => Snapshot(static s => s.Capped ? 1 : 0), description: "1 once a side hit the diagnostic price cap, so the max is a lower bound.");
    }

    /// <summary>Records one gateway level. <paramref name="present"/> is false when the size is zero.</summary>
    public void Note(InstrumentRoot root, BookSide side, long priceTicks, bool present, long nowMs)
    {
        LogSnapshot? snapshot = null;
        lock (_gate)
        {
            var series = SeriesFor(root);
            var set = SideSet(series, side);
            if (present)
            {
                if (!set.Contains(priceTicks))
                {
                    if (set.Count >= MaxPricesPerSide)
                    {
                        series.Capped = true;
                    }
                    else
                    {
                        set.Add(priceTicks);
                    }
                }
            }
            else
            {
                set.Remove(priceTicks);
            }

            var bids = series.Bids.Count;
            var asks = series.Asks.Count;
            if (bids > series.MaxBids)
            {
                series.MaxBids = bids;
            }

            if (asks > series.MaxAsks)
            {
                series.MaxAsks = asks;
            }

            if (series.LastSampleMs == nowMs && series.RingCount > 0)
            {
                // Rows that share a timestamp are one book, not a sample of the first price in the burst.
                ReplaceLast(series, bids, asks);
            }
            else if (series.LastSampleMs == long.MinValue || nowMs - series.LastSampleMs >= SampleIntervalMs)
            {
                var hadSample = series.TotalSamples > 0;
                Push(series, bids, asks);
                series.LastSampleMs = nowMs;
                if (hadSample && (series.LastLogMs == long.MinValue || nowMs - series.LastLogMs >= LogIntervalMs))
                {
                    series.LastLogMs = nowMs;
                    snapshot = new LogSnapshot(
                        root,
                        series.MaxBids,
                        Median(series, bids: true) ?? 0,
                        series.MaxAsks,
                        Median(series, bids: false) ?? 0,
                        bids,
                        asks,
                        series.TotalSamples,
                        series.Capped);
                }
            }
        }

        if (snapshot is { } line)
        {
            Log.Width(
                _logger,
                line.Root,
                line.MaxBids,
                line.TypicalBids,
                line.MaxAsks,
                line.TypicalAsks,
                line.CurrentBids,
                line.CurrentAsks,
                line.Samples,
                line.Capped,
                _levelsPerSide,
                _ladderLevels);
        }
    }

    /// <summary>Drops the current prices for <paramref name="root"/>. The max, the median and the sample count stay.</summary>
    public void ClearBook(InstrumentRoot root)
    {
        lock (_gate)
        {
            if (_series.TryGetValue(root, out var series))
            {
                series.Bids.Clear();
                series.Asks.Clear();
            }
        }
    }

    public DepthWidthReport Report()
    {
        lock (_gate)
        {
            var rows = new List<InstrumentDepthWidth>(_series.Count);
            foreach (var pair in _series)
            {
                var series = pair.Value;
                rows.Add(new InstrumentDepthWidth(
                    pair.Key.ToString(),
                    series.MaxBids,
                    Median(series, bids: true),
                    series.MaxAsks,
                    Median(series, bids: false),
                    series.Bids.Count,
                    series.Asks.Count,
                    series.TotalSamples,
                    series.Capped));
            }

            rows.Sort(static (a, b) => string.CompareOrdinal(a.Instrument, b.Instrument));
            return new DepthWidthReport(_levelsPerSide, _ladderLevels, MaxPricesPerSide, rows);
        }
    }

    public void Dispose() => _meter.Dispose();

    private Series SeriesFor(InstrumentRoot root)
    {
        if (!_series.TryGetValue(root, out var series))
        {
            series = new Series();
            _series[root] = series;
        }

        return series;
    }

    private static HashSet<long> SideSet(Series series, BookSide side) => side switch
    {
        BookSide.Bid => series.Bids,
        BookSide.Ask => series.Asks,
        _ => throw new ArgumentOutOfRangeException(nameof(side), side, "A depth row is a bid or an ask."),
    };

    private static void Push(Series series, int bids, int asks)
    {
        series.Ring[series.RingNext] = (bids, asks);
        series.RingNext = (series.RingNext + 1) % SampleRingCapacity;
        if (series.RingCount < SampleRingCapacity)
        {
            series.RingCount++;
        }

        series.TotalSamples++;
    }

    private static void ReplaceLast(Series series, int bids, int asks)
    {
        var last = (series.RingNext - 1 + SampleRingCapacity) % SampleRingCapacity;
        series.Ring[last] = (bids, asks);
    }

    private static int? Median(Series series, bool bids)
    {
        if (series.RingCount == 0)
        {
            return null;
        }

        var values = new int[series.RingCount];
        var start = series.RingCount < SampleRingCapacity ? 0 : series.RingNext;
        for (var i = 0; i < series.RingCount; i++)
        {
            var sample = series.Ring[(start + i) % SampleRingCapacity];
            values[i] = bids ? sample.Bids : sample.Asks;
        }

        Array.Sort(values);
        return values[(values.Length - 1) / 2];
    }

    private Measurement<long>[] Snapshot(Func<Series, long> value)
    {
        lock (_gate)
        {
            var list = new Measurement<long>[_series.Count];
            var i = 0;
            foreach (var pair in _series)
            {
                list[i++] = new Measurement<long>(value(pair.Value), Tag(pair.Key));
            }

            return list;
        }
    }

    private Measurement<long>[] SnapshotTypical(bool bids)
    {
        lock (_gate)
        {
            var list = new List<Measurement<long>>();
            foreach (var pair in _series)
            {
                if (Median(pair.Value, bids) is { } typical)
                {
                    list.Add(new Measurement<long>(typical, Tag(pair.Key)));
                }
            }

            return [.. list];
        }
    }

    private static KeyValuePair<string, object?> Tag(InstrumentRoot root) => new("instrument", root.ToString());

    private sealed class Series
    {
        public HashSet<long> Bids { get; } = [];

        public HashSet<long> Asks { get; } = [];

        public int MaxBids { get; set; }

        public int MaxAsks { get; set; }

        public bool Capped { get; set; }

        public long LastSampleMs { get; set; } = long.MinValue;

        public long LastLogMs { get; set; } = long.MinValue;

        public int TotalSamples { get; set; }

        public (int Bids, int Asks)[] Ring { get; } = new (int Bids, int Asks)[SampleRingCapacity];

        public int RingCount { get; set; }

        public int RingNext { get; set; }
    }

    private readonly record struct LogSnapshot(
        InstrumentRoot Root,
        int MaxBids,
        int TypicalBids,
        int MaxAsks,
        int TypicalAsks,
        int CurrentBids,
        int CurrentAsks,
        int Samples,
        bool Capped);

    private static partial class Log
    {
        [LoggerMessage(
            Level = LogLevel.Information,
            Message = "ProjectX depth width {Root}: bid max {MaxBids} typical {TypicalBids}, ask max {MaxAsks} typical {TypicalAsks}, current bid {CurrentBids} ask {CurrentAsks}, samples {Samples}, capped {Capped}, LevelsPerSide {LevelsPerSide}, LadderLevels {LadderLevels}")]
        public static partial void Width(
            ILogger logger,
            InstrumentRoot root,
            int maxBids,
            int typicalBids,
            int maxAsks,
            int typicalAsks,
            int currentBids,
            int currentAsks,
            int samples,
            bool capped,
            int levelsPerSide,
            int ladderLevels);
    }
}

/// <summary>Received depth width for one process. No prices and no contract ids.</summary>
public sealed record DepthWidthReport(
    int LevelsPerSide,
    int LadderLevels,
    int MaxPricesPerSide,
    IReadOnlyList<InstrumentDepthWidth> Instruments);

/// <summary>One root's received depth width. Counts are prices, never quantities.</summary>
public sealed record InstrumentDepthWidth(
    string Instrument,
    int MaxBidLevels,
    int? TypicalBidLevels,
    int MaxAskLevels,
    int? TypicalAskLevels,
    int CurrentBidLevels,
    int CurrentAskLevels,
    int Samples,
    bool Capped);
