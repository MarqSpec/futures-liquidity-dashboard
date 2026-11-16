namespace MarqSpec.FuturesLiquidityDashboard.Core.Profile;

/// <summary>A dropped-trade hole. <see cref="UntilMs"/> is null while the gap is still open.</summary>
public readonly record struct MissingRange(long SinceMs, long? UntilMs);

/// <summary>Point of control and value area of a profile (REQUIREMENTS.md FR-24).</summary>
public sealed record ValueArea(long PocTicks, long HighTicks, long LowTicks, long Volume, long TotalVolume)
{
    /// <summary>The fraction of window volume inside the value area; at least the target, the overshoot reported.</summary>
    public double Fraction => TotalVolume == 0 ? 0 : (double)Volume / TotalVolume;
}

/// <summary>A profile reading: executed contracts by native tick, and how complete the window is (REQUIREMENTS.md FR-23, FR-25).</summary>
public sealed record ProfileSnapshot
{
    public required string Window { get; init; }

    public required IReadOnlyList<KeyValuePair<long, long>> Bins { get; init; }

    public required long TotalVolume { get; init; }

    public ValueArea? ValueArea { get; init; }

    /// <summary>Unix ms from which the window is complete; set when the window started before collection did.</summary>
    public long? PartialSinceMs { get; init; }

    /// <summary>Dropped-trade holes still inside this window. <see cref="MissingRange.UntilMs"/> is null while the gap is open.</summary>
    public IReadOnlyList<MissingRange> MissingRanges { get; init; } = [];

    /// <summary>
    /// Minutes filled from a closed one-minute bar after a drop. The volume is the bar's total, not the prints,
    /// so the range stays approximate until it rolls off (D-33).
    /// </summary>
    public IReadOnlyList<MissingRange> ApproximateRanges { get; init; } = [];
}

/// <summary>
/// Executed volume at price for one window, independent of the viewport (ARCHITECTURE.md, Profile engine).
/// A rolling window expires old executions by one-second buckets; a session window resets at each new session.
/// Cancellations never count: only trades are added (REQUIREMENTS.md §1 terminology, FR-14).
/// </summary>
public sealed class VolumeProfile
{
    private readonly SortedDictionary<long, long> _bins = [];
    private readonly SortedDictionary<long, Dictionary<long, long>> _buckets = [];
    private readonly long? _rollingMs;

    private VolumeProfile(string window, long? rollingMs)
    {
        Window = window;
        _rollingMs = rollingMs;
    }

    public string Window { get; }

    public long TotalVolume { get; private set; }

    public long? PartialSinceMs { get; private set; }

    /// <summary>Closed holes kept per profile. A burst of reconnects cannot grow the list without bound (D-32).</summary>
    public const int MaxClosedRanges = 32;

    private readonly List<MissingRange> _missing = [];
    private readonly List<MissingRange> _approximate = [];
    private long? _openMissingSince;

    public string? SessionId { get; private set; }

    public static VolumeProfile Session() => new("session", null);

    public static VolumeProfile Rolling(TimeSpan window, string name) => new(name, (long)window.TotalMilliseconds);

    /// <summary>Starts a new session window; <paramref name="partialSinceMs"/> marks a window that began before collection.</summary>
    public void ResetSession(string sessionId, long? partialSinceMs)
    {
        SessionId = sessionId;
        PartialSinceMs = partialSinceMs;
        _missing.Clear();
        _approximate.Clear();
        _openMissingSince = null;
        _bins.Clear();
        _buckets.Clear();
        TotalVolume = 0;
    }

    public void MarkPartialSince(long timeMs) => PartialSinceMs ??= timeMs;

    /// <summary>Opens a hole at <paramref name="timeMs"/>, or keeps the earlier open start.</summary>
    public void MarkMissingSince(long timeMs)
    {
        if (_openMissingSince is { } open)
        {
            if (timeMs < open)
            {
                _openMissingSince = timeMs;
            }

            return;
        }

        _openMissingSince = timeMs;
    }

    /// <summary>
    /// Ends the open hole at <paramref name="untilMs"/> and keeps the range until the window drops it.
    /// Returns how many older ranges were dropped to stay within <see cref="MaxClosedRanges"/>.
    /// </summary>
    public int CloseMissing(long untilMs)
    {
        if (_openMissingSince is not { } since)
        {
            return 0;
        }

        _missing.Add(new MissingRange(since, untilMs));
        _openMissingSince = null;
        var dropped = 0;
        while (_missing.Count > MaxClosedRanges)
        {
            _missing.RemoveAt(0);
            dropped++;
        }

        return dropped;
    }

    /// <summary>Closed approximate ranges still inside this window, merged and capped like the holes.</summary>
    public IReadOnlyList<MissingRange> ApproximateRanges => _approximate;

    /// <summary>Records <paramref name="sinceMs"/>..<paramref name="untilMs"/> as bar-repaired volume.</summary>
    public void MarkApproximate(long sinceMs, long untilMs)
    {
        if (untilMs <= sinceMs)
        {
            return;
        }

        _approximate.Add(new MissingRange(sinceMs, untilMs));
        _approximate.Sort(static (left, right) => left.SinceMs.CompareTo(right.SinceMs));
        for (var i = 0; i < _approximate.Count - 1;)
        {
            var leftUntil = _approximate[i].UntilMs ?? long.MaxValue;
            if (leftUntil < _approximate[i + 1].SinceMs)
            {
                i++;
                continue;
            }

            var rightUntil = _approximate[i + 1].UntilMs ?? long.MaxValue;
            var merged = Math.Max(leftUntil, rightUntil);
            _approximate[i] = new MissingRange(_approximate[i].SinceMs, merged == long.MaxValue ? null : merged);
            _approximate.RemoveAt(i + 1);
        }

        while (_approximate.Count > MaxClosedRanges)
        {
            _approximate.RemoveAt(0);
        }
    }

    public IReadOnlyList<MissingRange> Ranges()
    {
        if (_openMissingSince is not { } open)
        {
            return _missing;
        }

        var all = new List<MissingRange>(_missing.Count + 1);
        all.AddRange(_missing);
        all.Add(new MissingRange(open, null));
        return all;
    }

    public void Add(long timeMs, long priceTicks, long quantity)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(quantity);
        _bins[priceTicks] = _bins.GetValueOrDefault(priceTicks) + quantity;
        TotalVolume += quantity;
        if (_rollingMs is null)
        {
            return;
        }

        var second = timeMs - (timeMs % 1000);
        // A repaired minute is older than the live tail. Keying by second keeps that volume in the window
        // that actually contains it, and Expire still drops the oldest second first.
        if (!_buckets.TryGetValue(second, out var bucket))
        {
            bucket = [];
            _buckets[second] = bucket;
        }

        bucket[priceTicks] = bucket.GetValueOrDefault(priceTicks) + quantity;
    }

    /// <summary>Drops executions older than the rolling window as of <paramref name="nowMs"/>.</summary>
    public void Expire(long nowMs)
    {
        if (_rollingMs is not { } window)
        {
            return;
        }

        var cutoff = nowMs - window;
        while (_buckets.Count > 0)
        {
            var oldest = _buckets.First();
            if (oldest.Key + 1000 > cutoff)
            {
                break;
            }

            _buckets.Remove(oldest.Key);
            foreach (var (price, quantity) in oldest.Value)
            {
                var left = _bins[price] - quantity;
                if (left == 0)
                {
                    _bins.Remove(price);
                }
                else
                {
                    _bins[price] = left;
                }

                TotalVolume -= quantity;
            }
        }

        _missing.RemoveAll(range => range.UntilMs is { } until && until <= cutoff);
        _approximate.RemoveAll(range => range.UntilMs is { } until && until <= cutoff);
    }

    public ProfileSnapshot Snapshot(double valueAreaTarget = 0.70) => new()
    {
        Window = Window,
        Bins = _bins.ToList(),
        TotalVolume = TotalVolume,
        ValueArea = ComputeValueArea(_bins, valueAreaTarget),
        PartialSinceMs = PartialSinceMs,
        MissingRanges = Ranges(),
        ApproximateRanges = _approximate.ToList(),
    };

    /// <summary>
    /// POC is the highest-volume bin, ties to the lower price. The value area expands contiguously from the POC, adding
    /// the higher-volume adjacent bin (the lower price on ties), until it holds at least the target share (REQUIREMENTS.md FR-24).
    /// Missing ticks between traded prices count as zero-volume bins.
    /// </summary>
    public static ValueArea? ComputeValueArea(IReadOnlyDictionary<long, long> bins, double target = 0.70)
    {
        ArgumentNullException.ThrowIfNull(bins);
        var total = bins.Values.Sum();
        if (total == 0)
        {
            return null;
        }

        var poc = bins.Where(b => b.Value > 0).OrderByDescending(b => b.Value).ThenBy(b => b.Key).First().Key;
        var low = poc;
        var high = poc;
        var minPrice = bins.Keys.Min();
        var maxPrice = bins.Keys.Max();
        var volume = bins[poc];
        var needed = (long)Math.Ceiling(total * target);
        while (volume < needed && (low > minPrice || high < maxPrice))
        {
            long? below = low > minPrice ? bins.GetValueOrDefault(low - 1) : null;
            long? above = high < maxPrice ? bins.GetValueOrDefault(high + 1) : null;
            if (below is { } b && (above is not { } a || b >= a))
            {
                low--;
                volume += b;
            }
            else if (above is { } up)
            {
                high++;
                volume += up;
            }
        }

        return new ValueArea(poc, high, low, volume, total);
    }
}
