namespace MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

/// <summary>One MACD reading: line = EMA(fast) − EMA(slow), signal = EMA(signal) of the line, histogram = line − signal.</summary>
public readonly record struct MacdValue(double Line, double? Signal)
{
    public double? Histogram => Signal is { } s ? Line - s : null;
}

/// <summary>MACD with EMAs that follow the FR-17 seed rule (REQUIREMENTS.md FR-20); proposed 12/26/9.</summary>
public sealed class Macd
{
    private readonly Ema _fast;
    private readonly Ema _slow;
    private readonly Ema _signal;

    public Macd(int fast = 12, int slow = 26, int signal = 9)
    {
        if (fast >= slow)
        {
            throw new ArgumentException("The fast period must be shorter than the slow period.", nameof(fast));
        }

        _fast = new Ema(fast);
        _slow = new Ema(slow);
        _signal = new Ema(signal);
    }

    public MacdValue? Value { get; private set; }

    public MacdValue? Update(double close)
    {
        var fast = _fast.Update(close);
        var slow = _slow.Update(close);
        if (fast is not { } f || slow is not { } s)
        {
            return null;
        }

        var line = f - s;
        Value = new MacdValue(line, _signal.Update(line));
        return Value;
    }

    public MacdValue? Developing(double provisionalClose)
    {
        if (_fast.Developing(provisionalClose) is not { } f || _slow.Developing(provisionalClose) is not { } s)
        {
            return null;
        }

        var line = f - s;
        return new MacdValue(line, _signal.Developing(line));
    }
}
