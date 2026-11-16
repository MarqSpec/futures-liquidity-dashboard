namespace MarqSpec.FuturesLiquidityDashboard.Core.Regime;

/// <summary>
/// Wilder's average directional index with its +DI and −DI (REQUIREMENTS.md FR-56). +DM is today's high minus yesterday's
/// when that beats the fall in the low (and is positive); −DM the other way. True range, +DM and −DM are smoothed by
/// Wilder's method, seeded with the sum of the first N; DX = 100·|+DI − −DI| / (+DI + −DI); ADX is the mean of the
/// first N DX values, then Wilder-smoothed. Unready until 2N bars have been seen.
/// </summary>
public sealed class Adx
{
    private double? _previousHigh;
    private double? _previousLow;
    private double? _previousClose;
    private double _trSum;
    private double _plusSum;
    private double _minusSum;
    private int _moves;
    private double _dxSeed;
    private int _dxCount;

    public Adx(int period = 14)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(period, 1);
        Period = period;
    }

    public int Period { get; }

    public double? Value { get; private set; }

    public double? PlusDi { get; private set; }

    public double? MinusDi { get; private set; }

    /// <summary>Bars needed before the first value.</summary>
    public int WarmupBars => 2 * Period;

    public double? Update(double high, double low, double close)
    {
        if (_previousHigh is { } ph && _previousLow is { } pl)
        {
            var up = high - ph;
            var down = pl - low;
            var plusDm = up > down && up > 0 ? up : 0;
            var minusDm = down > up && down > 0 ? down : 0;
            var tr = Math.Max(high - low, Math.Max(Math.Abs(high - _previousClose!.Value), Math.Abs(low - _previousClose.Value)));
            _moves++;
            if (_moves <= Period)
            {
                _trSum += tr;
                _plusSum += plusDm;
                _minusSum += minusDm;
            }
            else
            {
                _trSum = _trSum - (_trSum / Period) + tr;
                _plusSum = _plusSum - (_plusSum / Period) + plusDm;
                _minusSum = _minusSum - (_minusSum / Period) + minusDm;
            }

            if (_moves >= Period)
            {
                PlusDi = _trSum > 0 ? 100 * _plusSum / _trSum : 0;
                MinusDi = _trSum > 0 ? 100 * _minusSum / _trSum : 0;
                var sum = PlusDi.Value + MinusDi.Value;
                var dx = sum > 0 ? 100 * Math.Abs(PlusDi.Value - MinusDi.Value) / sum : 0;
                if (Value is { } previous)
                {
                    Value = ((previous * (Period - 1)) + dx) / Period;
                }
                else
                {
                    _dxSeed += dx;
                    _dxCount++;
                    if (_dxCount == Period)
                    {
                        Value = _dxSeed / Period;
                    }
                }
            }
        }

        _previousHigh = high;
        _previousLow = low;
        _previousClose = close;
        return Value;
    }
}
