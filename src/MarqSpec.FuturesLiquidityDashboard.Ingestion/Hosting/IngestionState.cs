using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;

/// <summary>What the ingestion service has done so far, for readiness and the status chip (OBSERVABILITY.md §3).</summary>
public sealed class IngestionState
{
    private readonly Lock _gate = new();
    private string? _lastError;
    private bool _historyLoaded;
    private bool _streaming;
    private long _restarts;

    public string FeedName { get; init; } = "unknown";

    public FeedProvenance Provenance { get; init; }

    public bool HistoryLoaded
    {
        get
        {
            lock (_gate)
            {
                return _historyLoaded;
            }
        }
    }

    public bool Streaming
    {
        get
        {
            lock (_gate)
            {
                return _streaming;
            }
        }
    }

    public string? LastError
    {
        get
        {
            lock (_gate)
            {
                return _lastError;
            }
        }
    }

    public long Restarts
    {
        get
        {
            lock (_gate)
            {
                return _restarts;
            }
        }
    }

    /// <summary>Ready once history has loaded (or there is none) and the stream has started.</summary>
    public bool Ready => HistoryLoaded && Streaming;

    internal void MarkHistoryLoaded()
    {
        lock (_gate)
        {
            _historyLoaded = true;
        }
    }

    internal void MarkStreaming()
    {
        lock (_gate)
        {
            _streaming = true;
            _lastError = null;
        }
    }

    internal void MarkFailed(string error)
    {
        lock (_gate)
        {
            _streaming = false;
            _lastError = error;
            _restarts++;
        }
    }
}
