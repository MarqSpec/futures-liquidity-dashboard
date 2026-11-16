namespace MarqSpec.FuturesLiquidityDashboard.Core.Indicators;

/// <summary>Session VWAP and the ±1σ and ±2σ bands around it, in the same units as <see cref="VwapValue.Vwap"/>.</summary>
public readonly record struct VwapBands(double Minus2, double Minus1, double Vwap, double Plus1, double Plus2)
{
    public static VwapBands From(VwapValue value) => new(
        value.Vwap - (2 * value.StdDev),
        value.Vwap - value.StdDev,
        value.Vwap,
        value.Vwap + value.StdDev,
        value.Vwap + (2 * value.StdDev));
}
