namespace MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

/// <summary>A VWAP reading with its volume-weighted standard deviation, for ±1σ/±2σ bands.</summary>
public readonly record struct VwapValue(double Vwap, double StdDev, long Volume);

/// <summary>
/// Sum(price × quantity) / sum(quantity) since the anchor (REQUIREMENTS.md FR-18). Zero volume is undefined (null).
/// Publication cadence never resets the accumulation; only <see cref="Reset"/> does, at a new anchor.
/// </summary>
public sealed class SessionVwap
{
    private double _priceVolume;
    private double _priceSquaredVolume;
    private long _volume;

    public string? AnchorId { get; private set; }

    /// <summary>True when trade coverage since the anchor is incomplete (a mid-session start without backfill).</summary>
    public bool IsPartial { get; private set; }

    public VwapValue? Value => _volume == 0 ? null : Compute();

    public void Reset(string anchorId, bool partial)
    {
        AnchorId = anchorId;
        IsPartial = partial;
        _priceVolume = 0;
        _priceSquaredVolume = 0;
        _volume = 0;
    }

    public void Add(double price, long quantity)
    {
        _priceVolume += price * quantity;
        _priceSquaredVolume += price * price * quantity;
        _volume += quantity;
    }

    private VwapValue Compute()
    {
        var vwap = _priceVolume / _volume;
        var variance = Math.Max(0, (_priceSquaredVolume / _volume) - (vwap * vwap));
        return new VwapValue(vwap, Math.Sqrt(variance), _volume);
    }
}
