using System.ComponentModel.DataAnnotations;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;

/// <summary>When the feeds pull depth (REQUIREMENTS.md FR-54).</summary>
public enum DepthMode
{
    /// <summary>Depth only for products someone watches, plus the pinned ones (the default).</summary>
    Watched,

    /// <summary>Depth for every product, as the MVP did. Fine for a handful of products; heavy for all of them.</summary>
    All,
}

/// <summary>The <c>Feed:Depth</c> configuration section (DEPLOYMENT.md §3).</summary>
public sealed class DepthOptions
{
    public DepthMode Mode { get; set; } = DepthMode.Watched;

    /// <summary>Products that always get depth, watched or not, so their heatmap history is always there.</summary>
    public List<string> Pinned { get; set; } = [];

    /// <summary>Most products with depth at once; the pinned ones count first. 0 means no limit.</summary>
    [Range(0, 500)]
    public int MaxSubscriptions { get; set; } = 8;

    /// <summary>How long depth stays on after the last viewer leaves, so flicking between products does not churn.</summary>
    [Range(0, 3_600_000)]
    public int ReleaseDelayMs { get; set; } = 30_000;
}

/// <summary>
/// Which products want depth right now (REQUIREMENTS.md FR-54): the pinned ones, every product a viewer watches (reference
/// counted, so two viewers of one product hold it once), and for <see cref="DepthOptions.ReleaseDelayMs"/> after the
/// last viewer leaves. The feeds read <see cref="Wanted"/> on their own loop and subscribe or unsubscribe depth to
/// match; a product past <see cref="DepthOptions.MaxSubscriptions"/> gets trades and quotes only. Thread-safe.
/// </summary>
public sealed class DepthDemand
{
    private readonly DepthOptions _options;
    private readonly TimeProvider _time;
    private readonly Lock _gate = new();
    private readonly List<InstrumentRoot> _pinned;
    private readonly Dictionary<InstrumentRoot, int> _counts = [];
    private readonly Dictionary<InstrumentRoot, long> _sinceMs = [];
    private readonly Dictionary<InstrumentRoot, long> _releasedAtMs = [];
    private long _version;

    public DepthDemand(DepthOptions options, TimeProvider time)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _time = time ?? throw new ArgumentNullException(nameof(time));
        _pinned = [];
        foreach (var value in options.Pinned)
        {
            if (!InstrumentRoot.TryParse(value, out var root))
            {
                throw new InvalidOperationException($"Feed:Depth:Pinned lists '{value}', which is not an instrument root.");
            }

            if (!_pinned.Contains(root))
            {
                _pinned.Add(root);
            }
        }
    }

    /// <summary>Depth for every product, regardless of viewers.</summary>
    public static DepthDemand Everything(TimeProvider? time = null) => new(new DepthOptions { Mode = DepthMode.All }, time ?? TimeProvider.System);

    public DepthMode Mode => _options.Mode;

    public int MaxSubscriptions => _options.MaxSubscriptions;

    /// <summary>Increases whenever <see cref="Acquire"/> or <see cref="Release"/> changes the demand.</summary>
    public long Version => Interlocked.Read(ref _version);

    /// <summary>One more viewer wants depth for <paramref name="root"/>.</summary>
    public void Acquire(InstrumentRoot root)
    {
        lock (_gate)
        {
            var count = _counts.GetValueOrDefault(root);
            _counts[root] = count + 1;
            if (count == 0)
            {
                _releasedAtMs.Remove(root);
                _sinceMs.TryAdd(root, Now());
            }

            Interlocked.Increment(ref _version);
        }
    }

    /// <summary>One viewer fewer for <paramref name="root"/>; depth stays on for the release delay after the last.</summary>
    public void Release(InstrumentRoot root)
    {
        lock (_gate)
        {
            if (!_counts.TryGetValue(root, out var count))
            {
                return;
            }

            if (count <= 1)
            {
                _counts.Remove(root);
                _releasedAtMs[root] = Now();
            }
            else
            {
                _counts[root] = count - 1;
            }

            Interlocked.Increment(ref _version);
        }
    }

    /// <summary>Current viewers of <paramref name="root"/>.</summary>
    public int Viewers(InstrumentRoot root)
    {
        lock (_gate)
        {
            return _counts.GetValueOrDefault(root);
        }
    }

    /// <summary>
    /// The products among <paramref name="available"/> that should have depth now, in priority order: pinned, then
    /// watched or lingering by when they were first wanted, cut at the limit. <paramref name="limited"/> lists the
    /// wanted products the limit left out.
    /// </summary>
    public IReadOnlySet<InstrumentRoot> Wanted(IReadOnlyCollection<InstrumentRoot> available, out IReadOnlyList<InstrumentRoot> limited)
    {
        ArgumentNullException.ThrowIfNull(available);
        var offered = available as IReadOnlySet<InstrumentRoot> ?? available.ToHashSet();
        if (_options.Mode == DepthMode.All)
        {
            limited = [];
            return offered.ToHashSet();
        }

        var now = Now();
        List<InstrumentRoot> candidates;
        lock (_gate)
        {
            foreach (var expired in _releasedAtMs.Where(r => now - r.Value >= _options.ReleaseDelayMs).Select(r => r.Key).ToList())
            {
                _releasedAtMs.Remove(expired);
                _sinceMs.Remove(expired);
            }

            candidates = [.. _pinned.Where(offered.Contains)];
            candidates.AddRange(_sinceMs
                .Where(s => offered.Contains(s.Key) && !_pinned.Contains(s.Key))
                .OrderBy(s => s.Value)
                .ThenBy(s => s.Key)
                .Select(s => s.Key));
        }

        var max = _options.MaxSubscriptions;
        if (max > 0 && candidates.Count > max)
        {
            limited = candidates[max..];
            return candidates[..max].ToHashSet();
        }

        limited = [];
        return candidates.ToHashSet();
    }

    /// <summary>Whether <paramref name="root"/> would get depth now if it is wanted (pinned or watched and within the limit).</summary>
    public bool Grants(InstrumentRoot root, IReadOnlyCollection<InstrumentRoot> available) => Wanted(available, out _).Contains(root);

    private long Now() => _time.GetUtcNow().ToUnixTimeMilliseconds();
}
