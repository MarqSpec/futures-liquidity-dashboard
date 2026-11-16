using System.Collections.Immutable;
using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Text.Json.Serialization;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

/// <summary>
/// One user's saved display settings (REQUIREMENTS.md FR-9, UC-8). Validated on save; unknown indicator or signal ids are
/// refused so a typo never silently hides a pane.
/// </summary>
public sealed record LayoutSettings
{
    public static IReadOnlySet<string> KnownPanes { get; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ema10", "ema13", "ema24", "ema48", "ema200", "vwap", "rsi14", "macd", "atr14",
        "heatmap", "footprint", "cvd", "profile-session", "profile-1h", "profile-4h", "profile-5d", "tpo", "ladder", "overlay",
    };

    public static IReadOnlySet<string> KnownSignals { get; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "Iceberg", "StackedImbalance", "UnfinishedAuction", "TrappedTraders", "CvdDivergence", "DeltaExhaustion",
        "Spoof", "LiquiditySweep", "SinglePrints",
    };

    public const int MaxWatchlist = 12;

    private const string FootprintPane = "footprint";

    /// <summary>
    /// Fields on the first layout document. A PUT that omits one still stores its default. Every other public
    /// init property is kept when the write omits it, so a field added later is not reset by a stale client.
    /// </summary>
    internal static IReadOnlySet<string> DefaultsWhenOmitted { get; } = new HashSet<string>(StringComparer.Ordinal)
    {
        nameof(Instrument),
        nameof(SliceSeconds),
        nameof(HistoryMinutes),
        nameof(HeatContrast),
        nameof(Panes),
        nameof(Signals),
    };

    private static readonly PropertyInfo[] CopiedWhenOmitted = typeof(LayoutSettings)
        .GetProperties(BindingFlags.Instance | BindingFlags.Public)
        .Where(property => property.CanWrite && !DefaultsWhenOmitted.Contains(property.Name))
        .ToArray();

    // Immutable so a record copy shares the set until a setter replaces it on that copy alone.
    private ImmutableHashSet<string> _specified = ImmutableHashSet<string>.Empty;

    private void Set<T>(string name, ref T slot, T value)
    {
        slot = value;
        _specified = _specified.Add(name);
    }

    internal bool WasSpecified(string name) => _specified.Contains(name);

    /// <summary>The product shown in the detailed view: any root. The default tab is MES (REQUIREMENTS.md FR-54, ARCHITECTURE.md D-28).</summary>
    [RegularExpression("^[A-Z0-9]{1,6}$")]
    public string Instrument { get; init; } = "MES";

    /// <summary>The products the viewer stars in the picker, which get depth while the viewer is connected (REQUIREMENTS.md FR-55).</summary>
    public List<string> Watchlist
    {
        get => _watchlist;
        init => Set(nameof(Watchlist), ref _watchlist, value);
    }

    private List<string> _watchlist = ["MES", "MCL", "MGC"];

    [Range(1, 5)]
    public int SliceSeconds { get; init; } = 1;

    /// <summary>Chart candles and heatmap columns share this interval, in minutes (1, 2, 5 or 15).</summary>
    public int ChartMinutes
    {
        get => _chartMinutes;
        init => Set(nameof(ChartMinutes), ref _chartMinutes, value);
    }

    private int _chartMinutes = 1;

    /// <summary>Indicator source timeframe, independent of <see cref="ChartMinutes"/> (1, 5 or 15).</summary>
    public int IndicatorMinutes
    {
        get => _indicatorMinutes;
        init => Set(nameof(IndicatorMinutes), ref _indicatorMinutes, value);
    }

    private int _indicatorMinutes = 1;

    /// <summary><c>intensity</c> or <c>flow</c> (resting size added versus pulled).</summary>
    [RegularExpression("^(intensity|flow)$")]
    public string HeatMode
    {
        get => _heatMode;
        init => Set(nameof(HeatMode), ref _heatMode, value);
    }

    private string _heatMode = "intensity";

    [Range(5, 4320)]
    public int HistoryMinutes { get; init; } = 240;

    [Range(0.1, 5.0)]
    public double HeatContrast { get; init; } = 1.0;

    /// <summary><c>standard</c> or <c>rips</c> (REQUIREMENTS.md FR-64). The preset changes which lines are drawn, not profile math.</summary>
    [RegularExpression("^(standard|rips)$")]
    public string Preset
    {
        get => _preset;
        init => Set(nameof(Preset), ref _preset, value);
    }

    private string _preset = "standard";

    /// <summary>Candles are optional. Volume dots stay the primary price mark when this is false (REQUIREMENTS.md FR-59).</summary>
    public bool ShowCandles
    {
        get => _showCandles;
        init => Set(nameof(ShowCandles), ref _showCandles, value);
    }

    private bool _showCandles;

    /// <summary>The volume-dot layer. On unless the viewer turns it off.</summary>
    public bool ShowVolumeDots
    {
        get => _showVolumeDots;
        init => Set(nameof(ShowVolumeDots), ref _showVolumeDots, value);
    }

    private bool _showVolumeDots = true;

    /// <summary>How far the heatmap ramp is dimmed, 0 to 1 (REQUIREMENTS.md FR-58).</summary>
    [Range(0, 1)]
    public double HeatDim
    {
        get => _heatDim;
        init => Set(nameof(HeatDim), ref _heatDim, value);
    }

    private double _heatDim;

    /// <summary>Lower percentile of the visible resting quantity mapped onto the ramp.</summary>
    [Range(0, 99)]
    public double HeatLowPercentile
    {
        get => _heatLowPercentile;
        init => Set(nameof(HeatLowPercentile), ref _heatLowPercentile, value);
    }

    private double _heatLowPercentile = 5;

    /// <summary>Upper percentile of the visible resting quantity mapped onto the ramp.</summary>
    [Range(1, 100)]
    public double HeatHighPercentile
    {
        get => _heatHighPercentile;
        init => Set(nameof(HeatHighPercentile), ref _heatHighPercentile, value);
    }

    private double _heatHighPercentile = 95;

    /// <summary>Stretch the visible window onto the ramp at draw time. Stored heat cells are not rewritten.</summary>
    public bool HeatAutoContrast
    {
        get => _heatAutoContrast;
        init => Set(nameof(HeatAutoContrast), ref _heatAutoContrast, value);
    }

    private bool _heatAutoContrast = true;

    /// <summary>Prints smaller than this are omitted from the dot layer and stay in the totals.</summary>
    [Range(1, 10_000)]
    public int DotMinQuantity
    {
        get => _dotMinQuantity;
        init => Set(nameof(DotMinQuantity), ref _dotMinQuantity, value);
    }

    private int _dotMinQuantity = 1;

    /// <summary>
    /// Order Flow event-marker size: <c>small</c>, <c>medium</c> or <c>large</c> (REQUIREMENTS.md FR-67).
    /// Slice volume dots stay sized by print quantity.
    /// </summary>
    [RegularExpression("^(small|medium|large)$")]
    public string EventDotSize
    {
        get => _eventDotSize;
        init => Set(nameof(EventDotSize), ref _eventDotSize, value);
    }

    private string _eventDotSize = "medium";

    /// <summary>
    /// When true, the Order Flow price scale stays centered on the last trade at the current zoom (REQUIREMENTS.md FR-67).
    /// A vertical drag or a price zoom turns it off in the client.
    /// A PUT that omits the property keeps the stored value. An explicit value, including false, replaces it.
    /// </summary>
    public bool CenterPrice
    {
        get => _centerPrice;
        init => Set(nameof(CenterPrice), ref _centerPrice, value);
    }

    private bool _centerPrice;

    private string _indicatorPane = FootprintPane;

    /// <summary>
    /// The Detail indicator dock tab (REQUIREMENTS.md FR-22): <c>footprint</c>, <c>cvd</c>, <c>rsi14</c>, <c>macd</c>,
    /// <c>atr14</c> or <c>tpo</c>. One tab is shown; <see cref="IndicatorDockCollapsed"/> hides it and keeps the tab strip.
    /// Order Flow does not read this.
    /// A PUT that omits the property leaves <see cref="IndicatorPaneSpecified"/> false so the stored tab is kept.
    /// An explicit value, including <c>footprint</c>, replaces it.
    /// </summary>
    [RegularExpression("^(footprint|cvd|rsi14|macd|atr14|tpo)$")]
    public string IndicatorPane
    {
        get => _indicatorPane;
        init => Set(nameof(IndicatorPane), ref _indicatorPane, value);
    }

    /// <summary>
    /// When true, the Detail indicator dock shows only its tab strip and the price chart takes the freed height
    /// (REQUIREMENTS.md FR-22, ARCHITECTURE.md D-39). Default false. An explicit null is refused. A PUT that omits the
    /// property keeps the stored value; an explicit value, including false, replaces it. Order Flow does not read this.
    /// </summary>
    public bool IndicatorDockCollapsed
    {
        get => _indicatorDockCollapsed;
        init => Set(nameof(IndicatorDockCollapsed), ref _indicatorDockCollapsed, value);
    }

    private bool _indicatorDockCollapsed;

    /// <summary>The Detail side-column sections that can collapse to their heading. Exact, lower-case keys.</summary>
    public static IReadOnlySet<string> KnownSideSections { get; } = new HashSet<string>(StringComparer.Ordinal)
    {
        "ladder", "liquidity", "signals", "levels", "profile", "layers",
    };

    /// <summary>
    /// The Detail side-column sections shown collapsed to their heading, as <see cref="KnownSideSections"/> keys
    /// (REQUIREMENTS.md FR-9). Default empty: every section open. An unknown key or a null list is refused.
    /// A PUT that omits the property keeps the stored list; an explicit list, including an empty one, replaces it.
    /// Order Flow does not read this.
    /// </summary>
    public List<string> SideSectionsCollapsed
    {
        get => _sideSectionsCollapsed;
        init => Set(nameof(SideSectionsCollapsed), ref _sideSectionsCollapsed, value);
    }

    private List<string> _sideSectionsCollapsed = [];

    /// <summary>True when this value set <see cref="IndicatorPane"/>, including an explicit default. Not part of the JSON document.</summary>
    [JsonIgnore]
    internal bool IndicatorPaneSpecified => WasSpecified(nameof(IndicatorPane));

    /// <summary>
    /// Keeps <paramref name="stored"/>'s indicator tab when this write did not send one.
    /// An explicit tab replaces the stored tab. An older client that omits the field must not reset it to footprint.
    /// </summary>
    public LayoutSettings PreservingStoredIndicatorPane(LayoutSettings stored) => PreservingStoredOmissions(stored);

    /// <summary>
    /// When true, the Order Flow chart draws a last-price step across the visible window (REQUIREMENTS.md FR-69).
    /// On unless the viewer turns it off. A PUT that omits the property keeps the stored value.
    /// An explicit value, including true, replaces it.
    /// </summary>
    public bool ShowPriceLine
    {
        get => _showPriceLine;
        init => Set(nameof(ShowPriceLine), ref _showPriceLine, value);
    }

    private bool _showPriceLine = true;

    /// <summary>Hide VAH and VAL lines. POC and the stored node values stay (REQUIREMENTS.md FR-64).</summary>
    public bool HideValueArea
    {
        get => _hideValueArea;
        init => Set(nameof(HideValueArea), ref _hideValueArea, value);
    }

    private bool _hideValueArea;

    /// <summary>Draw HVN shelves and LVN targets more strongly. Does not recompute nodes.</summary>
    public bool EmphasizeNodes
    {
        get => _emphasizeNodes;
        init => Set(nameof(EmphasizeNodes), ref _emphasizeNodes, value);
    }

    private bool _emphasizeNodes;

    /// <summary>
    /// Copies each field that is not in <see cref="DefaultsWhenOmitted"/> from <paramref name="stored"/> when this
    /// write did not send it. An explicit value, including the field's default, replaces the stored value. A field
    /// added later is kept when an older client omits it. The first document's fields still take their default
    /// when omitted.
    /// </summary>
    public LayoutSettings PreservingStoredOmissions(LayoutSettings stored)
    {
        ArgumentNullException.ThrowIfNull(stored);
        var next = this with { };
        foreach (var property in CopiedWhenOmitted)
        {
            if (_specified.Contains(property.Name))
            {
                continue;
            }

            property.SetValue(next, CloneWhenMutable(property.GetValue(stored)));
        }

        return next;
    }

    private static object? CloneWhenMutable(object? value) => value switch
    {
        null => null,
        Dictionary<string, bool> flags => new Dictionary<string, bool>(flags, StringComparer.Ordinal),
        List<string> list => list.ToList(),
        _ => value,
    };

    public Dictionary<string, bool> Panes { get; init; } = [];

    public Dictionary<string, bool> Signals { get; init; } = [];

    /// <summary>Every validation problem, empty when the layout is valid.</summary>
    public IReadOnlyList<string> Validate()
    {
        var results = new List<ValidationResult>();
        Validator.TryValidateObject(this, new ValidationContext(this), results, validateAllProperties: true);
        var errors = results.Select(r => r.ErrorMessage ?? "invalid").ToList();
        if (SliceSeconds is not (1 or 5))
        {
            errors.Add("SliceSeconds must be 1 or 5.");
        }

        if (Watchlist.Count > MaxWatchlist)
        {
            errors.Add($"Watchlist holds at most {MaxWatchlist} products.");
        }

        if (Watchlist.Distinct(StringComparer.Ordinal).Count() != Watchlist.Count)
        {
            errors.Add("Watchlist lists a product twice.");
        }

        errors.AddRange(Watchlist.Where(r => !System.Text.RegularExpressions.Regex.IsMatch(r ?? string.Empty, "^[A-Z0-9]{1,6}$"))
            .Select(r => $"Watchlist entry '{r}' is not a product root."));

        if (ChartMinutes is not (1 or 2 or 5 or 15))
        {
            errors.Add("ChartMinutes must be 1, 2, 5 or 15.");
        }

        if (IndicatorMinutes is not (1 or 5 or 15))
        {
            errors.Add("IndicatorMinutes must be 1, 5 or 15.");
        }

        if (HeatHighPercentile <= HeatLowPercentile)
        {
            errors.Add("HeatHighPercentile must be above HeatLowPercentile.");
        }

        if (EventDotSize is not ("small" or "medium" or "large"))
        {
            errors.Add("EventDotSize must be small, medium or large.");
        }

        if (IndicatorPane is not ("footprint" or "cvd" or "rsi14" or "macd" or "atr14" or "tpo"))
        {
            errors.Add("IndicatorPane must be footprint, cvd, rsi14, macd, atr14 or tpo.");
        }

        if (SideSectionsCollapsed is null)
        {
            errors.Add("SideSectionsCollapsed must be a list, not null.");
        }
        else
        {
            errors.AddRange(SideSectionsCollapsed.Where(k => k is null || !KnownSideSections.Contains(k))
                .Select(k => $"SideSectionsCollapsed names an unknown section '{k}'."));
        }

        errors.AddRange(Panes.Keys.Where(k => !KnownPanes.Contains(k)).Select(k => $"Unknown pane '{k}'."));
        errors.AddRange(Signals.Keys.Where(k => !KnownSignals.Contains(k)).Select(k => $"Unknown signal '{k}'."));
        return errors;
    }
}

/// <summary>
/// A layout plus whether this process has one for the caller. <see cref="Saved"/> is false after a restart until a
/// client re-sends a valid copy. <see cref="Revision"/> is a server-issued counter: 0 when nothing is stored, and
/// one greater after each accepted save.
/// </summary>
public sealed record LayoutDocument
{
    public bool Saved { get; init; }

    public long Revision { get; init; }

    public LayoutSettings Layout { get; init; } = new();
}

/// <summary>
/// The body of PUT /api/layouts/me. <see cref="Revision"/> is the counter the caller last read (0 when the server
/// has nothing stored). It is not a clock.
/// </summary>
public sealed record LayoutWrite
{
    public long Revision { get; init; }

    public LayoutSettings? Layout { get; init; }
}

/// <summary>The outcome of a compare-and-set save. <see cref="Document"/> is what the store holds afterwards.</summary>
public sealed record LayoutSaveResult(bool Applied, LayoutDocument Document);

/// <summary>
/// Layouts by user name for this process. Market state stays in memory (ARCHITECTURE.md D-18); a layout survives a
/// restart because the browser keeps a valid copy and re-PUTs it when <see cref="Get"/> reports nothing saved.
/// A save applies only when the caller's revision is the one stored, so a stale write cannot replace a later one.
/// </summary>
public sealed class LayoutStore
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, LayoutDocument> _layouts = new(StringComparer.Ordinal);

    public LayoutDocument Get(string user)
    {
        ArgumentNullException.ThrowIfNull(user);
        lock (_gate)
        {
            return _layouts.TryGetValue(user, out var layout) ? layout : Unsaved();
        }
    }

    /// <summary>
    /// Stores <paramref name="layout"/> when <paramref name="expectedRevision"/> equals the revision held for
    /// <paramref name="user"/> (0 when nothing is saved). The stored revision becomes that value plus one.
    /// Any other revision stores nothing and returns the document still held.
    /// </summary>
    public LayoutSaveResult Save(string user, LayoutSettings layout, long expectedRevision)
    {
        ArgumentNullException.ThrowIfNull(user);
        ArgumentNullException.ThrowIfNull(layout);
        lock (_gate)
        {
            var current = _layouts.TryGetValue(user, out var held) ? held : Unsaved();
            if (expectedRevision != current.Revision)
            {
                return new LayoutSaveResult(false, current);
            }

            var stored = new LayoutDocument
            {
                Saved = true,
                Revision = checked(current.Revision + 1),
                Layout = layout,
            };
            _layouts[user] = stored;
            return new LayoutSaveResult(true, stored);
        }
    }

    private static LayoutDocument Unsaved() => new() { Saved = false, Revision = 0, Layout = new LayoutSettings() };
}
