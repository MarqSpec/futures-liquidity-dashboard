using System.Globalization;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

/// <summary>
/// One contract of one instrument root: everything keyed by contract ID, tick size and expiry (REQUIREMENTS.md FR-5).
/// Prices inside the engine are integer tick keys; <see cref="ToTicks"/> rejects an invalid increment.
/// </summary>
public sealed record InstrumentSpec
{
    public required InstrumentRoot Root { get; init; }

    public required string Name { get; init; }

    public required string Exchange { get; init; }

    public required string ContractId { get; init; }

    public required DateOnly Expiry { get; init; }

    public required decimal TickSize { get; init; }

    /// <summary>US dollars per tick for one contract.</summary>
    public required decimal TickValue { get; init; }

    public required int PriceDecimals { get; init; }

    /// <summary>The product group the product picker sorts by (for example "Equity index" or "Energy").</summary>
    public string Sector { get; init; } = InstrumentCatalog.OtherSector;

    /// <summary>TPO row height in ticks (one round increment of the contract); 0 lets the engine choose.</summary>
    public int TpoRowTicks { get; init; }

    /// <summary>Converts a price to its integer tick key, or throws when the price is not a whole number of ticks.</summary>
    public long ToTicks(decimal price)
    {
        var ticks = price / TickSize;
        return decimal.Truncate(ticks) != ticks
            ? throw new InvalidPriceIncrementException(this, price)
            : (long)ticks;
    }

    /// <summary>Tries to convert a price to ticks; false when the price is not a whole number of ticks.</summary>
    public bool TryToTicks(decimal price, out long ticks)
    {
        var raw = price / TickSize;
        ticks = (long)decimal.Truncate(raw);
        return decimal.Truncate(raw) == raw;
    }

    public decimal ToPrice(long ticks) => ticks * TickSize;

    public string Format(long ticks) =>
        ToPrice(ticks).ToString("F" + PriceDecimals.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
}

/// <summary>A price that is not a whole number of ticks for its contract (REQUIREMENTS.md FR-5).</summary>
public sealed class InvalidPriceIncrementException(InstrumentSpec spec, decimal price)
    : Exception($"Price {price.ToString(CultureInfo.InvariantCulture)} is not a multiple of tick size {spec.TickSize.ToString(CultureInfo.InvariantCulture)} for {spec.ContractId}.");
