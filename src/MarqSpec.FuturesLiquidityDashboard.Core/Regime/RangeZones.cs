using MarqSpec.FuturesLiquidityDashboard.Core.Bars;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Regime;

/// <summary>
/// One stretch where FR-56 classified consecutive closed bars Ranging (REQUIREMENTS.md FR-75): from the first bar's open to the
/// last bar's close, between the lowest low and the highest high traded in those bars, in ticks.
/// </summary>
public sealed record RangeZoneDto(long StartMs, long EndMs, long LowTicks, long HighTicks);

/// <summary>One regime timeframe's range zones, oldest first (INTERFACES.md D.2).</summary>
public sealed record RangeZoneSetDto(int TimeframeSeconds, IReadOnlyList<RangeZoneDto> Zones);

/// <summary>
/// Merges consecutive closed bars that the regime rule classified Ranging into zones (REQUIREMENTS.md FR-75). A bar of any
/// other class, or a bar with no trades, ends the open zone, so a zone never spans time that was not called a range.
/// Only closed bars are added, so the newest zone grows as each Ranging bar closes and never holds the developing bar.
/// <see cref="Version"/> rises whenever <see cref="Zones"/> changes. Not thread-safe.
/// </summary>
public sealed class RangeZoneBuilder
{
    private readonly List<RangeZoneDto> _zones = [];
    private bool _open;

    /// <summary>The zones, oldest first; the last one is still growing while the latest closed bar was Ranging.</summary>
    public IReadOnlyList<RangeZoneDto> Zones => _zones;

    /// <summary>Rises on every change to <see cref="Zones"/>, so a publisher can tell whether to send them again.</summary>
    public long Version { get; private set; }

    /// <summary>Adds one closed bar with the class the regime rule gave it.</summary>
    public void Add(TradeBar bar, TrendRegime trend)
    {
        ArgumentNullException.ThrowIfNull(bar);
        if (trend != TrendRegime.Ranging || bar.IsEmpty || bar.Low is not { } low || bar.High is not { } high)
        {
            _open = false;
            return;
        }

        if (_open && _zones[^1] is { } last && last.EndMs == bar.StartMs)
        {
            _zones[^1] = last with { EndMs = bar.EndMs, LowTicks = Math.Min(last.LowTicks, low), HighTicks = Math.Max(last.HighTicks, high) };
        }
        else
        {
            _zones.Add(new RangeZoneDto(bar.StartMs, bar.EndMs, low, high));
        }

        _open = true;
        Version++;
    }

    /// <summary>Drops every zone that ended at or before <paramref name="cutoffMs"/>, the start of the retained bars.</summary>
    public void Trim(long cutoffMs)
    {
        var expired = 0;
        while (expired < _zones.Count && _zones[expired].EndMs <= cutoffMs)
        {
            expired++;
        }

        if (expired == 0)
        {
            return;
        }

        _zones.RemoveRange(0, expired);
        _open = _open && _zones.Count > 0;
        Version++;
    }
}
