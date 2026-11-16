using System.Diagnostics.Metrics;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

/// <summary>
/// Queue depth, coalesces, dropped trades and recoveries (OBSERVABILITY.md §2, REQUIREMENTS.md NFR-4). The meter name matches
/// <c>DashboardMetrics</c> so one <c>AddMeter</c> scrapes both. Labels are a fixed set (<c>lane</c>, <c>kind</c>).
/// </summary>
public sealed class IngestMetrics : IDisposable
{
    public const string MeterName = "MarqSpec.FuturesLiquidityDashboard";

    private readonly Meter _meter;
    private readonly Counter<long> _coalesced;
    private readonly Counter<long> _depthDiscarded;
    private readonly Counter<long> _droppedTrades;
    private readonly Counter<long> _lateSignals;
    private readonly Counter<long> _recoveries;
    private long _trades;
    private long _quotes;
    private long _depth;
    private long _controls;

    public IngestMetrics(IMeterFactory meters)
    {
        ArgumentNullException.ThrowIfNull(meters);
        _meter = meters.Create(MeterName);
        _meter.CreateObservableGauge("fld.ingest.queue_depth", ObserveDepth, description: "Events waiting in the ingest buffer, by lane.");
        _coalesced = _meter.CreateCounter<long>("fld.ingest.coalesced", description: "Quotes, depth rows or connection updates replaced by a newer one before the engine read them.");
        _depthDiscarded = _meter.CreateCounter<long>("fld.ingest.depth_discarded", description: "Pending depth rows thrown away because the price cap was passed or the contract disconnected. Not a coalesce.");
        _droppedTrades = _meter.CreateCounter<long>("fld.ingest.trades_dropped", description: "Trades that did not fit in that contract's queue. The contract is marked DEGRADED from the first drop.");
        _lateSignals = _meter.CreateCounter<long>("fld.orderflow.late_signals_dropped", description: "Order-flow signals not stored because their time was behind the newest signal already kept. The print is still applied.");
        _recoveries = _meter.CreateCounter<long>("fld.ingest.recoveries", description: "Contracts whose buffer overflowed, so trades are marked missing or the depth book is snapshotted again.");
    }

    public void SetDepths(int trades, int quotes, int depth, int controls)
    {
        Volatile.Write(ref _trades, trades);
        Volatile.Write(ref _quotes, quotes);
        Volatile.Write(ref _depth, depth);
        Volatile.Write(ref _controls, controls);
    }

    public void AddCoalesced(string lane, long count)
    {
        if (count > 0)
        {
            _coalesced.Add(count, new KeyValuePair<string, object?>("lane", lane));
        }
    }

    public void AddDroppedTrades(long count)
    {
        if (count > 0)
        {
            _droppedTrades.Add(count);
        }
    }

    /// <summary>Counts order-flow signals refused for arriving behind the newest one already kept.</summary>
    public void AddDroppedLateSignals(long count)
    {
        if (count > 0)
        {
            _lateSignals.Add(count);
        }
    }

    public void AddDepthDiscarded(long count)
    {
        if (count > 0)
        {
            _depthDiscarded.Add(count);
        }
    }

    public void AddRecovery(string kind) => _recoveries.Add(1, new KeyValuePair<string, object?>("kind", kind));

    public void Dispose() => _meter.Dispose();

    private IEnumerable<Measurement<long>> ObserveDepth()
    {
        yield return new Measurement<long>(Volatile.Read(ref _trades), new KeyValuePair<string, object?>("lane", "trade"));
        yield return new Measurement<long>(Volatile.Read(ref _quotes), new KeyValuePair<string, object?>("lane", "quote"));
        yield return new Measurement<long>(Volatile.Read(ref _depth), new KeyValuePair<string, object?>("lane", "depth"));
        yield return new Measurement<long>(Volatile.Read(ref _controls), new KeyValuePair<string, object?>("lane", "control"));
    }
}
