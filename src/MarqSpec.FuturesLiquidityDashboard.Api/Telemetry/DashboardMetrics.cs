using System.Diagnostics.Metrics;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Telemetry;

/// <summary>Per-instrument feed health gauges for Prometheus (OBSERVABILITY.md §2).</summary>
public sealed class DashboardMetrics : IDisposable
{
    public const string MeterName = IngestMetrics.MeterName;
    private readonly Meter _meter;
    private readonly Counter<long> _publishSkipped;
    private readonly Counter<long> _publishTimeouts;
    private long _publishInFlight;

    public DashboardMetrics(IMeterFactory meters, EngineRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(meters);
        ArgumentNullException.ThrowIfNull(registry);
        _meter = meters.Create(MeterName);
        _meter.CreateObservableGauge("fld.feed.event_age", () => Each(registry, s => s.LastEventAgeMs ?? -1), "ms",
            "Milliseconds since the last upstream event, per instrument (-1 before the first).");
        _meter.CreateObservableGauge("fld.feed.connected", () => Each(registry, s => s.Connected ? 1 : 0), description: "1 while the upstream session is connected.");
        _meter.CreateObservableGauge("fld.book.known", () => Each(registry, s => s.BookKnown ? 1 : 0), description: "1 while the order book is known.");
        _meter.CreateObservableGauge("fld.feed.rejected_events", () => Each(registry, s => s.RejectedEvents), description: "Events refused by validation.");
        _meter.CreateObservableGauge("fld.feed.clock_ahead_rejected_events", () => Each(registry, s => s.ClockAheadRejectedEvents),
            description: "Of the refused events, those stamped more than 60 s after they were received (host or upstream clock drift).");
        _publishSkipped = _meter.CreateCounter<long>("fld.publish.skipped", description: "Deltas not delivered because that browser was still taking the previous send, or discarded when its catch-up buffer overflowed. A delta held behind an in-flight snapshot and sent after it is not counted.");
        _publishTimeouts = _meter.CreateCounter<long>("fld.publish.aborted", description: "Browser connections aborted after Api:PublishTimeoutMs. The write already in the transport is not undone.");
        _meter.CreateObservableGauge("fld.publish.in_flight", () => Volatile.Read(ref _publishInFlight), description: "Delta sends currently waiting on a browser.");
    }

    public void PublishSendStarted() => Interlocked.Increment(ref _publishInFlight);

    public void PublishSendFinished() => Interlocked.Decrement(ref _publishInFlight);

    public void PublishSkipped(int count)
    {
        if (count > 0)
        {
            _publishSkipped.Add(count);
        }
    }

    public void PublishAborted() => _publishTimeouts.Add(1);

    public void Dispose() => _meter.Dispose();

    private static IEnumerable<Measurement<long>> Each(EngineRegistry registry, Func<StatusDto, long> value) =>
        registry.All.Select(e => new Measurement<long>(value(e.Status()), new KeyValuePair<string, object?>("instrument", e.Spec.Root.ToString())));
}
