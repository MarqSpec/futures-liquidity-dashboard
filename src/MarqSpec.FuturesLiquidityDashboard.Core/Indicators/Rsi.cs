namespace MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

/// <summary>
/// Wilder's RSI on close-to-close changes (REQUIREMENTS.md FR-19), seeded with the simple averages of the first N gains and
/// losses; ready after N changes (N + 1 closes).
/// </summary>
public sealed class Rsi
{
    private double? _previousClose;
    private double _gainSum;
    private double _lossSum;
    private int _changes;
    private double _avgGain;
    private double _avgLoss;

    public Rsi(int period = 14)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(period, 1);
        Period = period;
    }

    public int Period { get; }

    public double? Value { get; private set; }

    public double? Update(double close)
    {
        if (_previousClose is not { } previous)
        {
            _previousClose = close;
            return null;
        }

        var change = close - previous;
        _previousClose = close;
        var gain = Math.Max(change, 0);
        var loss = Math.Max(-change, 0);
        _changes++;
        if (_changes < Period)
        {
            _gainSum += gain;
            _lossSum += loss;
            return null;
        }

        if (_changes == Period)
        {
            _avgGain = (_gainSum + gain) / Period;
            _avgLoss = (_lossSum + loss) / Period;
        }
        else
        {
            _avgGain = ((_avgGain * (Period - 1)) + gain) / Period;
            _avgLoss = ((_avgLoss * (Period - 1)) + loss) / Period;
        }

        Value = Compute(_avgGain, _avgLoss);
        return Value;
    }

    public double? Developing(double provisionalClose)
    {
        if (Value is null || _previousClose is not { } previous)
        {
            return null;
        }

        var change = provisionalClose - previous;
        var gain = ((_avgGain * (Period - 1)) + Math.Max(change, 0)) / Period;
        var loss = ((_avgLoss * (Period - 1)) + Math.Max(-change, 0)) / Period;
        return Compute(gain, loss);
    }

    private static double Compute(double avgGain, double avgLoss) =>
        avgLoss == 0 ? (avgGain == 0 ? 50 : 100) : 100 - (100 / (1 + (avgGain / avgLoss)));
}
