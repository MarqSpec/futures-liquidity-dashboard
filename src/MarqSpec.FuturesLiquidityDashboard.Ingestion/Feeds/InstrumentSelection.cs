using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;

/// <summary>
/// The products to stream (REQUIREMENTS.md FR-10, FR-54), from <c>Engine:Instruments</c> and <c>Engine:ExcludeInstruments</c>.
/// <c>["*"]</c>, or no list at all, means every product the feed offers: the whole catalog for the synthetic feed,
/// and every contract the gateway lists for the ProjectX feed. Otherwise only the roots named.
/// </summary>
public sealed record InstrumentSelection
{
    public const string AllToken = "*";

    /// <summary>Every product the feed offers, less <see cref="Excluded"/>.</summary>
    public required bool All { get; init; }

    /// <summary>The roots named, in order (empty when <see cref="All"/>).</summary>
    public required IReadOnlyList<InstrumentRoot> Roots { get; init; }

    public IReadOnlySet<InstrumentRoot> Excluded { get; init; } = new HashSet<InstrumentRoot>();

    public static InstrumentSelection Everything { get; } = new() { All = true, Roots = [] };

    public static InstrumentSelection Of(params InstrumentRoot[] roots) => new() { All = false, Roots = roots.Distinct().ToList() };

    /// <summary>The engines to create before the feed has said what it offers: the catalog products selected.</summary>
    public IReadOnlyList<InstrumentSpec> InitialSpecs() =>
        All
            ? InstrumentCatalog.All.Where(s => !Excluded.Contains(s.Root)).ToList()
            : Roots.Where(r => InstrumentCatalog.TryGet(r, out _) && !Excluded.Contains(r)).Select(InstrumentCatalog.For).ToList();

    /// <summary>Named roots the catalog does not describe: only a feed that discovers contracts can stream them.</summary>
    public IReadOnlyList<InstrumentRoot> Uncatalogued() => All ? [] : Roots.Where(r => !InstrumentCatalog.TryGet(r, out _)).ToList();

    /// <summary>Whether the selection takes <paramref name="root"/>.</summary>
    public bool Includes(InstrumentRoot root) => !Excluded.Contains(root) && (All || Roots.Contains(root));
}
