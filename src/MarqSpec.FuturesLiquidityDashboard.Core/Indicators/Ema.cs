namespace MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

/// <summary>
/// Exponential moving average on closed source bars (REQUIREMENTS.md FR-17): alpha = 2 / (N + 1), seeded with the simple
/// average of the first N closes. Unready until N closes have been seen.
/// </summary>
public sealed class Ema
{
    private readonly double _alpha;
    private double _seedSum;
    private int _count;

    public Ema(int period)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(period, 1);
        Period = period;
        _alpha = 2.0 / (period + 1);
    }

    public int Period { get; }

    public double? Value { get; private set; }

    public bool IsReady => Value.HasValue;

    /// <summary>Closed values seen so far, including warmup.</summary>
    public int Count => _count;

    public double? Update(double close)
    {
        _count++;
        if (Value is { } previous)
        {
            Value = previous + (_alpha * (close - previous));
        }
        else
        {
            _seedSum += close;
            if (_count == Period)
            {
                Value = _seedSum / Period;
            }
        }

        return Value;
    }

    /// <summary>The value if <paramref name="provisionalClose"/> closed the current bar; never changes closed state.</summary>
    public double? Developing(double provisionalClose) =>
        Value is { } previous ? previous + (_alpha * (provisionalClose - previous)) : null;
}
