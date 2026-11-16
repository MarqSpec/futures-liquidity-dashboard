namespace MarqSpec.FuturesLiquidityDashboard.Core.Regime;

/// <summary>
/// Kaufman's efficiency ratio over N bars (REQUIREMENTS.md FR-56): the net move |close − close N bars ago| divided by the sum
/// of the N bar-to-bar moves. 1 is a straight line, near 0 is chop; a market that did not move at all reads 0.
/// Unready until N + 1 closes have been seen.
/// </summary>
public sealed class EfficiencyRatio
{
    private readonly Queue<double> _closes = new();
    private double _path;

    public EfficiencyRatio(int period = 20)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(period, 1);
        Period = period;
    }

    public int Period { get; }

    public double? Value { get; private set; }

    public double? Update(double close)
    {
        if (_closes.Count > 0)
        {
            _path += Math.Abs(close - _closes.Last());
        }

        _closes.Enqueue(close);
        if (_closes.Count > Period + 1)
        {
            var dropped = _closes.Dequeue();
            _path -= Math.Abs(_closes.Peek() - dropped);
        }

        if (_closes.Count == Period + 1)
        {
            var net = Math.Abs(close - _closes.Peek());
            Value = _path > 1e-9 ? Math.Clamp(net / _path, 0, 1) : 0;
        }

        return Value;
    }
}
