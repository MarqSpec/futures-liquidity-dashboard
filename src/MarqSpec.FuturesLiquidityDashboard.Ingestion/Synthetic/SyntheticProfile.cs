using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Synthetic;

/// <summary>
/// The shape of one synthetic market: a plausible price, volatility, trade rate and resting size for the contract.
/// These numbers are illustrative, not measured; Stage 0 replaces them with recorded rates (ARCHITECTURE.md).
/// </summary>
public sealed record SyntheticProfile
{
    public required decimal StartPrice { get; init; }

    /// <summary>Standard deviation of the fair price per square-root second, in ticks, in normal activity.</summary>
    public required double VolatilityTicks { get; init; }

    /// <summary>Executions per second during regular trading hours in normal activity.</summary>
    public required double TradesPerSecond { get; init; }

    public required double MeanTradeSize { get; init; }

    /// <summary>Typical resting quantity at the best price.</summary>
    public required double TopOfBookSize { get; init; }

    /// <summary>Relative growth of resting size per level away from the best price.</summary>
    public required double DepthGrowth { get; init; }

    /// <summary>Round-number spacing in ticks; those prices attract more resting size.</summary>
    public required int RoundNumberTicks { get; init; }

    /// <summary>
    /// The profile of the original three full-size contracts, and the same activity on their micro twins (the default
    /// tabs, ARCHITECTURE.md D-28). Every other catalog product gets a plausible starting price and an activity tier.
    /// A product outside the catalog gets a generic profile priced at a thousand ticks, so the synthetic market can
    /// simulate any root the configuration names.
    /// </summary>
    public static SyntheticProfile For(InstrumentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        if (spec.Root == InstrumentRoot.ES || spec.Root == InstrumentRoot.MES)
        {
            return new SyntheticProfile
            {
                StartPrice = 6852.25m,
                VolatilityTicks = 0.55,
                TradesPerSecond = 9,
                MeanTradeSize = 3.2,
                TopOfBookSize = 38,
                DepthGrowth = 0.16,
                RoundNumberTicks = 20,
            };
        }

        if (spec.Root == InstrumentRoot.GC || spec.Root == InstrumentRoot.MGC)
        {
            return new SyntheticProfile
            {
                StartPrice = 4048.6m,
                VolatilityTicks = 0.9,
                TradesPerSecond = 2.6,
                MeanTradeSize = 1.6,
                TopOfBookSize = 6,
                DepthGrowth = 0.12,
                RoundNumberTicks = 50,
            };
        }

        if (spec.Root == InstrumentRoot.CL || spec.Root == InstrumentRoot.MCL)
        {
            return new SyntheticProfile
            {
                StartPrice = 61.47m,
                VolatilityTicks = 0.75,
                TradesPerSecond = 4.2,
                MeanTradeSize = 2.1,
                TopOfBookSize = 14,
                DepthGrowth = 0.14,
                RoundNumberTicks = 25,
            };
        }

        var (price, tier) = Starts.TryGetValue(spec.Root.Value, out var known) ? known : (spec.TickSize * 1000, Tier.Low);
        var round = Math.Max(5, (spec.TpoRowTicks > 0 ? spec.TpoRowTicks : 4) * 5);
        return tier switch
        {
            Tier.High => new SyntheticProfile
            {
                StartPrice = price,
                VolatilityTicks = 0.8,
                TradesPerSecond = 6,
                MeanTradeSize = 2.6,
                TopOfBookSize = 24,
                DepthGrowth = 0.15,
                RoundNumberTicks = round,
            },
            Tier.Medium => new SyntheticProfile
            {
                StartPrice = price,
                VolatilityTicks = 0.7,
                TradesPerSecond = 2,
                MeanTradeSize = 1.8,
                TopOfBookSize = 10,
                DepthGrowth = 0.13,
                RoundNumberTicks = round,
            },
            _ => new SyntheticProfile
            {
                StartPrice = price,
                VolatilityTicks = 0.6,
                TradesPerSecond = 0.6,
                MeanTradeSize = 1.4,
                TopOfBookSize = 5,
                DepthGrowth = 0.12,
                RoundNumberTicks = round,
            },
        };
    }

    private enum Tier
    {
        High,
        Medium,
        Low,
    }

    // Illustrative starting prices only (each a whole number of the catalog's ticks), never market data.
    private static readonly Dictionary<string, (decimal Price, Tier Tier)> Starts = new(StringComparer.Ordinal)
    {
        ["MES"] = (6852.25m, Tier.High),
        ["NQ"] = (25120.50m, Tier.High),
        ["MNQ"] = (25120.50m, Tier.High),
        ["RTY"] = (2465.30m, Tier.Medium),
        ["M2K"] = (2465.30m, Tier.Medium),
        ["YM"] = (47250m, Tier.Medium),
        ["MYM"] = (47250m, Tier.Medium),
        ["NKD"] = (50100m, Tier.Low),
        ["MCL"] = (61.47m, Tier.Medium),
        ["QM"] = (61.475m, Tier.Low),
        ["NG"] = (4.312m, Tier.Medium),
        ["QG"] = (4.315m, Tier.Low),
        ["RB"] = (1.9845m, Tier.Low),
        ["HO"] = (2.4120m, Tier.Low),
        ["MGC"] = (4048.6m, Tier.Medium),
        ["SI"] = (48.250m, Tier.Medium),
        ["SIL"] = (48.250m, Tier.Low),
        ["HG"] = (5.0125m, Tier.Medium),
        ["MHG"] = (5.0125m, Tier.Low),
        ["PL"] = (1560.4m, Tier.Low),
        ["ZT"] = (104.25m, Tier.Medium),
        ["ZF"] = (108.5m, Tier.Medium),
        ["ZN"] = (112.25m, Tier.High),
        ["TN"] = (115.5m, Tier.Low),
        ["ZB"] = (117.5m, Tier.Medium),
        ["UB"] = (121.25m, Tier.Low),
        ["6A"] = (0.65405m, Tier.Medium),
        ["6B"] = (1.3125m, Tier.Medium),
        ["6C"] = (0.71245m, Tier.Medium),
        ["6E"] = (1.15425m, Tier.High),
        ["6J"] = (0.0065015m, Tier.Medium),
        ["6S"] = (1.24680m, Tier.Low),
        ["6M"] = (0.05412m, Tier.Low),
        ["6N"] = (0.57210m, Tier.Low),
        ["E7"] = (1.1543m, Tier.Low),
        ["M6E"] = (1.1543m, Tier.Low),
        ["M6A"] = (0.6541m, Tier.Low),
        ["M6B"] = (1.3125m, Tier.Low),
        ["ZC"] = (432.25m, Tier.Medium),
        ["ZW"] = (538.50m, Tier.Medium),
        ["ZS"] = (1121.75m, Tier.Medium),
        ["ZM"] = (318.4m, Tier.Low),
        ["ZL"] = (50.12m, Tier.Low),
        ["HE"] = (82.375m, Tier.Low),
        ["LE"] = (228.450m, Tier.Low),
        ["MBT"] = (101250m, Tier.Medium),
        ["MET"] = (3420.50m, Tier.Low),
    };
}
