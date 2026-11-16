using System.Collections.Frozen;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Engine;

/// <summary>
/// Holds one engine per enabled instrument; instruments never share state (REQUIREMENTS.md P4, FR-10). The set is fixed at
/// startup from configuration and may be replaced once by the feed's contract discovery (REQUIREMENTS.md FR-54), before any
/// event reaches an engine. <see cref="All"/> is in product-picker order: by sector, then catalog order, then root.
/// </summary>
public sealed class EngineRegistry
{
    private readonly EngineOptions _options;
    private readonly ExchangeCalendar _calendar;
    private readonly Lock _gate = new();
    private volatile State _state;

    public EngineRegistry(IEnumerable<InstrumentRoot> enabled, EngineOptions options, ExchangeCalendar calendar)
        : this((enabled ?? throw new ArgumentNullException(nameof(enabled))).Distinct().Select(InstrumentCatalog.For), options, calendar)
    {
    }

    public EngineRegistry(IEnumerable<InstrumentSpec> specs, EngineOptions options, ExchangeCalendar calendar)
    {
        ArgumentNullException.ThrowIfNull(specs);
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _calendar = calendar ?? throw new ArgumentNullException(nameof(calendar));
        _state = Build(specs.DistinctBy(s => s.Root).Select(s => new InstrumentEngine(s, options, calendar)));
    }

    public IReadOnlyList<InstrumentEngine> All => _state.Ordered;

    /// <summary>The options every engine is built with.</summary>
    public EngineOptions Options => _options;

    public IReadOnlyCollection<InstrumentRoot> Enabled => _state.ByRoot.Keys;

    public bool TryGet(InstrumentRoot root, out InstrumentEngine engine) => _state.ByRoot.TryGetValue(root, out engine!);

    /// <summary>
    /// Replaces an instrument's engine with a fresh one for <paramref name="spec"/>: used once at startup when the
    /// feed resolves the contract it will actually stream (for example the front month the gateway lists), before
    /// any event reaches the engine.
    /// </summary>
    public InstrumentEngine Rebind(InstrumentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        lock (_gate)
        {
            if (!_state.ByRoot.ContainsKey(spec.Root))
            {
                throw new InvalidOperationException($"Instrument {spec.Root} is not enabled.");
            }

            var engine = new InstrumentEngine(spec, _options, _calendar);
            _state = Build(_state.Ordered.Select(e => e.Spec.Root == spec.Root ? engine : e));
            return engine;
        }
    }

    /// <summary>
    /// Replaces the whole instrument set with fresh engines for <paramref name="specs"/>: used once at startup when
    /// the feed discovers the products it can stream (REQUIREMENTS.md FR-54), before any event reaches an engine.
    /// </summary>
    public void Replace(IEnumerable<InstrumentSpec> specs)
    {
        ArgumentNullException.ThrowIfNull(specs);
        lock (_gate)
        {
            _state = Build(specs.DistinctBy(s => s.Root).Select(s => new InstrumentEngine(s, _options, _calendar)));
        }
    }

    private static State Build(IEnumerable<InstrumentEngine> engines)
    {
        var ordered = engines
            .OrderBy(e => InstrumentCatalog.SectorOrder(e.Spec.Sector))
            .ThenBy(e => InstrumentCatalog.Order(e.Spec.Root))
            .ThenBy(e => e.Spec.Root)
            .ToList();
        return new State(ordered, ordered.ToFrozenDictionary(e => e.Spec.Root));
    }

    private sealed record State(IReadOnlyList<InstrumentEngine> Ordered, FrozenDictionary<InstrumentRoot, InstrumentEngine> ByRoot);
}
