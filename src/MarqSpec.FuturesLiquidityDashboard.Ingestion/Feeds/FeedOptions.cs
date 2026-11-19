using System.ComponentModel.DataAnnotations;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;

public enum FeedProvider
{
    Synthetic,
    Replay,
    ProjectX,
}

/// <summary>The <c>Feed</c> configuration section (DEPLOYMENT.md §3).</summary>
public sealed class FeedOptions
{
    public const string Section = "Feed";

    public FeedProvider Provider { get; set; } = FeedProvider.Synthetic;

    public SyntheticFeedOptions Synthetic { get; set; } = new();

    public ReplayFeedOptions Replay { get; set; } = new();

    public ProjectXFeedOptions ProjectX { get; set; } = new();

    /// <summary>Which products get depth (REQUIREMENTS.md FR-54).</summary>
    public DepthOptions Depth { get; set; } = new();

    /// <summary>
    /// Minimum hours of trade history loaded for warmup (EMA 200 on one-minute bars needs 200 minutes). History
    /// always reaches back to the session open when that is further, and far enough for the slowest regime
    /// timeframe to warm up (REQUIREMENTS.md FR-56), never more than 24 hours.
    /// </summary>
    [Range(0, 24)]
    public double MinHistoryHours { get; set; } = 4;

    /// <summary>
    /// Whether history reaches far enough back for the slowest regime timeframe to warm up (REQUIREMENTS.md FR-56). Off, a
    /// regime shows Unknown until enough live bars arrive; tests turn it off to start quickly.
    /// </summary>
    public bool WarmRegimes { get; set; } = true;

    /// <summary>How many products load their warmup history at once; a feed with a rate limit still spaces its calls.</summary>
    [Range(1, 64)]
    public int HistoryConcurrency { get; set; } = 4;

    /// <summary>Milliseconds between engine clock ticks while the feed is quiet (closes slices and bars, detects STALE).</summary>
    [Range(50, 5000)]
    public int TickMs { get; set; } = 250;

    /// <summary>Bounds for the live ingest queue (REQUIREMENTS.md NFR-4, ARCHITECTURE.md T-6, ARCHITECTURE.md D-32).</summary>
    public IngestBufferOptions Ingest { get; set; } = new();
}

/// <summary>
/// How the ingest queue behaves under a burst (ARCHITECTURE.md D-32). Each contract has its own trade queue.
/// A trade that does not fit is counted at once — the callback does not wait, because that would stall the
/// market-hub receive loop. Quotes and depth collapse to the latest value. A depth book past the level cap is
/// discarded and rebuilt from the settle-window snapshot.
/// </summary>
public sealed class IngestBufferOptions
{
    /// <summary>Most trades held for one contract. Past this the trade is counted and the contract is marked DEGRADED.</summary>
    [Range(1, 100_000)]
    public int TradeCapacity { get; set; } = 4_096;

    /// <summary>
    /// Most distinct pending depth prices per contract. A real book is far smaller; past this the pending book is
    /// thrown away and the contract restarts its snapshot (ARCHITECTURE.md D-32).
    /// </summary>
    [Range(8, 100_000)]
    public int DepthLevelsPerContract { get; set; } = 4_096;
}

/// <summary>The synthetic market (ARCHITECTURE.md D-12): deterministic for a seed, realistic in shape, never real data.</summary>
public sealed class SyntheticFeedOptions
{
    public int Seed { get; set; } = 20261108;

    /// <summary>Milliseconds between simulation steps.</summary>
    [Range(10, 1000)]
    public int StepMs { get; set; } = 50;

    /// <summary>Depth levels delivered per side.</summary>
    [Range(5, 50)]
    public int LevelsPerSide { get; set; } = 20;

    /// <summary>Seconds between simulated upstream outages; 0 turns them off.</summary>
    [Range(0, 86_400)]
    public int OutageIntervalSeconds { get; set; }

    [Range(100, 600_000)]
    public int OutageDurationMs { get; set; } = 5_000;
}

public sealed class ReplayFeedOptions
{
    /// <summary>A JSON-lines file of normalized events (MarketEventJsonContext).</summary>
    public string? Path { get; set; }

    public bool Loop { get; set; } = true;

    [Range(0.1, 100)]
    public double Speed { get; set; } = 1.0;
}

/// <summary>
/// TopstepX through the ProjectX gateway (ARCHITECTURE.md D-15). Credentials are not here: they come from the
/// environment or user-secrets, never a committed file. Set one pair only. <c>PROJECTX_USERNAME</c> and
/// <c>PROJECTX_API_KEY</c> (loginKey user name and api key) win when both pairs are set. Otherwise
/// <c>PROJECTX_API_KEY</c> is the user name and <c>PROJECTX_API_SECRET</c> is the api key.
/// </summary>
public sealed class ProjectXFeedOptions
{
    /// <summary>Gateway contract ids by root (for example <c>ES</c>); a root left out resolves to the active contract.</summary>
    public Dictionary<string, string> ContractIds { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The gateway's <c>live</c> flag on contract search and history (false is the documented default).</summary>
    public bool SearchLive { get; set; }

    /// <summary>Milliseconds of depth rows collected into the first book after a (re)subscription (assumption, Stage 0).</summary>
    [Range(200, 10_000)]
    public int SnapshotSettleMs { get; set; } = 1500;

    /// <summary>Least and most depth levels kept per side. The gateway may send fewer; those are not padded (REQUIREMENTS.md FR-11).</summary>
    public const int MinLevelsPerSide = 5;

    /// <summary>Upper bound. A live book of 50 was this process's ceiling; the gateway documents no maximum.</summary>
    public const int MaxLevelsPerSide = 200;

    /// <summary>Depth levels kept per side from the gateway book. Default 50 so a 40-level ladder is fed where the gateway sends that many.</summary>
    [Range(MinLevelsPerSide, MaxLevelsPerSide)]
    public int LevelsPerSide { get; set; } = 50;

    /// <summary>
    /// Most contracts streamed at once (trades and quotes); 0 streams every contract selected. ProjectX does not
    /// document a per-connection subscription limit (Stage 0 measures it); set this if the gateway refuses
    /// subscriptions past some count. Contracts past the limit are dropped in product-picker order and logged.
    /// </summary>
    [Range(0, 1000)]
    public int MaxContracts { get; set; }

    /// <summary>
    /// Least milliseconds between two warmup-history requests, to stay under the gateway's history rate limit
    /// (about 50 requests per 30 seconds per its documentation; unverified, Stage 0).
    /// </summary>
    [Range(0, 10_000)]
    public int HistoryMinIntervalMs { get; set; } = 650;

    /// <summary>Whether to subscribe to the quote stream (best bid and offer) for every contract.</summary>
    public bool Quotes { get; set; } = true;
}
