using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;

/// <summary>
/// A feed that streams contracts other than the catalog's defaults (for example the front months the ProjectX
/// gateway lists) resolves them before history or streaming starts, so each engine is bound to the real contract.
/// For a selection of every product it also discovers which products the feed offers (REQUIREMENTS.md FR-54).
/// </summary>
public interface IInstrumentResolver
{
    /// <summary>
    /// The contracts to stream for <paramref name="selection"/>. <paramref name="current"/> are the engines' specs
    /// so far (the catalog products selected); the result may add, drop or rebind products.
    /// </summary>
    Task<IReadOnlyList<InstrumentSpec>> ResolveAsync(InstrumentSelection selection, IReadOnlyList<InstrumentSpec> current, CancellationToken cancellationToken);
}
