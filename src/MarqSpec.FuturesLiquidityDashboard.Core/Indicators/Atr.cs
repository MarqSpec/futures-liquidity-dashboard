namespace MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

/// <summary>
/// Wilder's average true range (REQUIREMENTS.md FR-21): true range = max(high − low, |high − previous close|,
/// |low − previous close|); seeded with the mean of the first N true ranges.
/// </summary>
public sealed class Atr
{
    private double? _previousClose;
    private double _seedSum;
    private int _count;

    public Atr(int period = 14)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(period, 1);
        Period = period;
    }

    public int Period { get; }

    public double? Value { get; private set; }

    public double? Update(double high, double low, double close)
    {
        var trueRange = TrueRange(high, low, _previousClose);
        _previousClose = close;
        _count++;
        if (Value is { } previous)
        {
            Value = ((previous * (Period - 1)) + trueRange) / Period;
        }
        else
        {
            _seedSum += trueRange;
            if (_count == Period)
            {
                Value = _seedSum / Period;
            }
        }

        return Value;
    }

    public double? Developing(double high, double low) =>
        Value is { } previous ? ((previous * (Period - 1)) + TrueRange(high, low, _previousClose)) / Period : null;

    public static double TrueRange(double high, double low, double? previousClose) =>
        previousClose is { } pc
            ? Math.Max(high - low, Math.Max(Math.Abs(high - pc), Math.Abs(low - pc)))
            : high - low;
}
