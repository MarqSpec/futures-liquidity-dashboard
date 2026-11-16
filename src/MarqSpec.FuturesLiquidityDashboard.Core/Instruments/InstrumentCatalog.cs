using System.Collections.Frozen;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

/// <summary>
/// The static product list (ARCHITECTURE.md D-26): every futures root TopstepX lists, with its exchange tick metadata.
/// MES, MCL and MGC are the default tabs (D-28).
/// It is the instrument set of the synthetic and replay feeds and of the tests, and the fallback metadata (name,
/// exchange, sector, TPO row) for the ProjectX feed, which discovers the contracts it actually streams from the
/// gateway and takes tick size and tick value from there (INTERFACES.md Interface B). The contract IDs and
/// expiries are placeholders for the synthetic feed; the roll policy is open (ARCHITECTURE.md D-5). The list is
/// illustrative of TopstepX's product menu as of November 2026 and is not authoritative: the gateway's list wins.
/// </summary>
public static class InstrumentCatalog
{
    public const string EquitySector = "Equity index";
    public const string EnergySector = "Energy";
    public const string MetalsSector = "Metals";
    public const string RatesSector = "Interest rates";
    public const string CurrencySector = "Currencies";
    public const string AgricultureSector = "Agriculture";
    public const string CryptoSector = "Crypto";
    public const string OtherSector = "Other";

    /// <summary>The sectors in the order the product picker shows them.</summary>
    public static IReadOnlyList<string> Sectors { get; } =
    [
        EquitySector, EnergySector, MetalsSector, RatesSector, CurrencySector, AgricultureSector, CryptoSector, OtherSector,
    ];

    private static readonly DateOnly Dec26 = new(2026, 12, 18);

    public static InstrumentSpec ES { get; } = new()
    {
        Root = InstrumentRoot.ES,
        Name = "E-mini S&P 500",
        Exchange = "CME",
        ContractId = "ESZ26",
        Expiry = Dec26,
        TickSize = 0.25m,
        TickValue = 12.50m,
        PriceDecimals = 2,
        Sector = EquitySector,
        TpoRowTicks = 4,
    };

    public static InstrumentSpec GC { get; } = new()
    {
        Root = InstrumentRoot.GC,
        Name = "Gold",
        Exchange = "COMEX",
        ContractId = "GCG27",
        Expiry = new DateOnly(2027, 2, 24),
        TickSize = 0.10m,
        TickValue = 10.00m,
        PriceDecimals = 1,
        Sector = MetalsSector,
        TpoRowTicks = 10,
    };

    public static InstrumentSpec CL { get; } = new()
    {
        Root = InstrumentRoot.CL,
        Name = "Crude Oil WTI",
        Exchange = "NYMEX",
        ContractId = "CLF27",
        Expiry = new DateOnly(2026, 12, 17),
        TickSize = 0.01m,
        TickValue = 10.00m,
        PriceDecimals = 2,
        Sector = EnergySector,
        TpoRowTicks = 5,
    };

    /// <summary>Micro E-mini S&amp;P 500, a default tab (ARCHITECTURE.md D-28). Contract id is a synthetic placeholder.</summary>
    public static InstrumentSpec MES { get; } = new()
    {
        Root = InstrumentRoot.MES,
        Name = "Micro E-mini S&P 500",
        Exchange = "CME",
        ContractId = "MESZ26",
        Expiry = Dec26,
        TickSize = 0.25m,
        TickValue = 1.25m,
        PriceDecimals = 2,
        Sector = EquitySector,
        TpoRowTicks = 4,
    };

    /// <summary>Micro WTI, a default tab (ARCHITECTURE.md D-28). Contract id is a synthetic placeholder.</summary>
    public static InstrumentSpec MCL { get; } = new()
    {
        Root = InstrumentRoot.MCL,
        Name = "Micro WTI Crude Oil",
        Exchange = "NYMEX",
        ContractId = "MCLF27",
        Expiry = new DateOnly(2026, 12, 17),
        TickSize = 0.01m,
        TickValue = 1.00m,
        PriceDecimals = 2,
        Sector = EnergySector,
        TpoRowTicks = 5,
    };

    /// <summary>Micro gold, a default tab (ARCHITECTURE.md D-28). Contract id is a synthetic placeholder.</summary>
    public static InstrumentSpec MGC { get; } = new()
    {
        Root = InstrumentRoot.MGC,
        Name = "Micro Gold",
        Exchange = "COMEX",
        ContractId = "MGCG27",
        Expiry = new DateOnly(2027, 2, 24),
        TickSize = 0.10m,
        TickValue = 1.00m,
        PriceDecimals = 1,
        Sector = MetalsSector,
        TpoRowTicks = 10,
    };

    /// <summary>Every catalog product, in picker order: by sector, then as listed.</summary>
    public static IReadOnlyList<InstrumentSpec> All { get; } =
    [
        ES,
        MES,
        Spec("NQ", "E-mini Nasdaq-100", "CME", 0.25m, 5.00m, EquitySector, 20),
        Spec("MNQ", "Micro E-mini Nasdaq-100", "CME", 0.25m, 0.50m, EquitySector, 20),
        Spec("RTY", "E-mini Russell 2000", "CME", 0.10m, 5.00m, EquitySector, 10),
        Spec("M2K", "Micro E-mini Russell 2000", "CME", 0.10m, 0.50m, EquitySector, 10),
        Spec("YM", "E-mini Dow ($5)", "CBOT", 1m, 5.00m, EquitySector, 10),
        Spec("MYM", "Micro E-mini Dow", "CBOT", 1m, 0.50m, EquitySector, 10),
        Spec("NKD", "Nikkei 225 (USD)", "CME", 5m, 25.00m, EquitySector, 4),
        CL,
        MCL,
        Spec("QM", "E-mini Crude Oil", "NYMEX", 0.025m, 12.50m, EnergySector, 2),
        Spec("NG", "Natural Gas", "NYMEX", 0.001m, 10.00m, EnergySector, 5),
        Spec("QG", "E-mini Natural Gas", "NYMEX", 0.005m, 12.50m, EnergySector, 1),
        Spec("RB", "RBOB Gasoline", "NYMEX", 0.0001m, 4.20m, EnergySector, 50),
        Spec("HO", "NY Harbor ULSD", "NYMEX", 0.0001m, 4.20m, EnergySector, 50),
        GC,
        MGC,
        Spec("SI", "Silver", "COMEX", 0.005m, 25.00m, MetalsSector, 10),
        Spec("SIL", "Micro Silver", "COMEX", 0.005m, 5.00m, MetalsSector, 10),
        Spec("HG", "Copper", "COMEX", 0.0005m, 12.50m, MetalsSector, 10),
        Spec("MHG", "Micro Copper", "COMEX", 0.0005m, 1.25m, MetalsSector, 10),
        Spec("PL", "Platinum", "NYMEX", 0.10m, 5.00m, MetalsSector, 10),
        Spec("ZT", "2-Year T-Note", "CBOT", 0.00390625m, 7.8125m, RatesSector, 8),
        Spec("ZF", "5-Year T-Note", "CBOT", 0.0078125m, 7.8125m, RatesSector, 8),
        Spec("ZN", "10-Year T-Note", "CBOT", 0.015625m, 15.625m, RatesSector, 8),
        Spec("TN", "Ultra 10-Year T-Note", "CBOT", 0.015625m, 15.625m, RatesSector, 8),
        Spec("ZB", "30-Year T-Bond", "CBOT", 0.03125m, 31.25m, RatesSector, 8),
        Spec("UB", "Ultra T-Bond", "CBOT", 0.03125m, 31.25m, RatesSector, 8),
        Spec("6A", "Australian Dollar", "CME", 0.00005m, 5.00m, CurrencySector, 10),
        Spec("6B", "British Pound", "CME", 0.0001m, 6.25m, CurrencySector, 10),
        Spec("6C", "Canadian Dollar", "CME", 0.00005m, 5.00m, CurrencySector, 10),
        Spec("6E", "Euro FX", "CME", 0.00005m, 6.25m, CurrencySector, 10),
        Spec("6J", "Japanese Yen", "CME", 0.0000005m, 6.25m, CurrencySector, 10),
        Spec("6S", "Swiss Franc", "CME", 0.00005m, 6.25m, CurrencySector, 10),
        Spec("6M", "Mexican Peso", "CME", 0.00001m, 5.00m, CurrencySector, 10),
        Spec("6N", "New Zealand Dollar", "CME", 0.00005m, 5.00m, CurrencySector, 10),
        Spec("E7", "E-mini Euro FX", "CME", 0.0001m, 6.25m, CurrencySector, 10),
        Spec("M6E", "Micro EUR/USD", "CME", 0.0001m, 1.25m, CurrencySector, 10),
        Spec("M6A", "Micro AUD/USD", "CME", 0.0001m, 1.00m, CurrencySector, 10),
        Spec("M6B", "Micro GBP/USD", "CME", 0.0001m, 0.625m, CurrencySector, 10),
        Spec("ZC", "Corn", "CBOT", 0.25m, 12.50m, AgricultureSector, 4),
        Spec("ZW", "Chicago SRW Wheat", "CBOT", 0.25m, 12.50m, AgricultureSector, 4),
        Spec("ZS", "Soybeans", "CBOT", 0.25m, 12.50m, AgricultureSector, 4),
        Spec("ZM", "Soybean Meal", "CBOT", 0.10m, 10.00m, AgricultureSector, 10),
        Spec("ZL", "Soybean Oil", "CBOT", 0.01m, 6.00m, AgricultureSector, 10),
        Spec("HE", "Lean Hogs", "CME", 0.025m, 10.00m, AgricultureSector, 10),
        Spec("LE", "Live Cattle", "CME", 0.025m, 10.00m, AgricultureSector, 10),
        Spec("MBT", "Micro Bitcoin", "CME", 5m, 0.50m, CryptoSector, 20),
        Spec("MET", "Micro Ether", "CME", 0.50m, 0.05m, CryptoSector, 20),
    ];

    /// <summary>The original three full-size contracts of the MVP (ES, GC, CL).</summary>
    public static IReadOnlyList<InstrumentSpec> Core { get; } = [ES, GC, CL];

    private static readonly FrozenDictionary<InstrumentRoot, InstrumentSpec> ByRoot = All.ToFrozenDictionary(s => s.Root);

    /// <summary>The catalog entry for <paramref name="root"/>; throws for a root the catalog does not list.</summary>
    public static InstrumentSpec For(InstrumentRoot root) =>
        ByRoot.TryGetValue(root, out var spec)
            ? spec
            : throw new ArgumentOutOfRangeException(nameof(root), root, "The instrument catalog does not list this root.");

    /// <summary>The catalog entry for <paramref name="root"/>, if the catalog lists it.</summary>
    public static bool TryGet(InstrumentRoot root, out InstrumentSpec spec) => ByRoot.TryGetValue(root, out spec!);

    /// <summary>Parses a root case-insensitively (any 1-6 letters or digits, listed in the catalog or not).</summary>
    public static bool TryParse(string? value, out InstrumentRoot root) => InstrumentRoot.TryParse(value, out root);

    /// <summary>Decimal places a price needs to show every tick exactly (0.25 → 2, 0.03125 → 5, 5 → 0).</summary>
    public static int DecimalsFor(decimal tickSize)
    {
        if (tickSize <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(tickSize), tickSize, "A tick size must be positive.");
        }

        var decimals = 0;
        var value = tickSize;
        while (value != decimal.Truncate(value) && decimals < 10)
        {
            value *= 10;
            decimals++;
        }

        return decimals;
    }

    /// <summary>The sector's position in <see cref="Sectors"/>; unknown sectors sort last.</summary>
    public static int SectorOrder(string sector)
    {
        for (var i = 0; i < Sectors.Count; i++)
        {
            if (string.Equals(Sectors[i], sector, StringComparison.OrdinalIgnoreCase))
            {
                return i;
            }
        }

        return Sectors.Count;
    }

    /// <summary>The catalog position of a root, for a stable picker order; roots the catalog does not list sort last.</summary>
    public static int Order(InstrumentRoot root)
    {
        for (var i = 0; i < All.Count; i++)
        {
            if (All[i].Root == root)
            {
                return i;
            }
        }

        return All.Count;
    }

    private static InstrumentSpec Spec(string root, string name, string exchange, decimal tickSize, decimal tickValue, string sector, int tpoRowTicks) => new()
    {
        Root = InstrumentRoot.Parse(root),
        Name = name,
        Exchange = exchange,
        ContractId = root + "Z26",
        Expiry = Dec26,
        TickSize = tickSize,
        TickValue = tickValue,
        PriceDecimals = DecimalsFor(tickSize),
        Sector = sector,
        TpoRowTicks = tpoRowTicks,
    };
}
