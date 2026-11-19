using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>Entered when <see cref="Lease"/> is set; dispose it when the request ends. Otherwise the refusal.</summary>
public sealed record GateResult(IDisposable? Lease, FeedbackRefusal? Refusal);

/// <summary>
/// Per viewer: at most <see cref="FeedbackOptions.RequestsPerMinute"/> starts in any sliding minute, and one request in
/// flight (REQUIREMENTS.md FR-74). A refused request does not count as a start. State is in memory and keyed by the viewer's
/// key name, so it holds one small entry per configured key.
/// </summary>
public sealed class FeedbackGate(TimeProvider time, IOptions<FeedbackOptions> options)
{
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(1);
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Queue<DateTimeOffset>> _starts = new(StringComparer.Ordinal);
    private readonly HashSet<string> _inFlight = new(StringComparer.Ordinal);

    public GateResult TryEnter(string viewer)
    {
        ArgumentNullException.ThrowIfNull(viewer);
        var now = time.GetUtcNow();
        lock (_gate)
        {
            if (_inFlight.Contains(viewer))
            {
                return new GateResult(null, new FeedbackRefusal(FeedbackReasons.RequestInFlight, null));
            }

            if (!_starts.TryGetValue(viewer, out var starts))
            {
                starts = new Queue<DateTimeOffset>();
                _starts[viewer] = starts;
            }

            while (starts.Count > 0 && now - starts.Peek() >= Window)
            {
                starts.Dequeue();
            }

            if (starts.Count >= options.Value.RequestsPerMinute)
            {
                var wait = starts.Peek() + Window - now;
                return new GateResult(null, new FeedbackRefusal(FeedbackReasons.RateLimited, (int)Math.Ceiling(wait.TotalSeconds)));
            }

            starts.Enqueue(now);
            _inFlight.Add(viewer);
            return new GateResult(new Lease(this, viewer), null);
        }
    }

    private void Leave(string viewer)
    {
        lock (_gate)
        {
            _inFlight.Remove(viewer);
        }
    }

    private sealed class Lease(FeedbackGate gate, string viewer) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                gate.Leave(viewer);
            }
        }
    }
}
