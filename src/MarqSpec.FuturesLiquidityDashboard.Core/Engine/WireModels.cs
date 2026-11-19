using MarqSpec.FuturesLiquidityDashboard.Core.Levels;
using MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

using MarqSpec.FuturesLiquidityDashboard.Core.Regime;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Engine;

// The browser contract of INTERFACES.md Interface D.2. Prices are integer ticks unless named Price;
// times are Unix milliseconds (UTC). Arrays are compact on purpose: one 60-minute snapshot holds thousands of cells.

public sealed record InstrumentInfo(
    string Root,
    string Name,
    string Exchange,
    string ContractId,
    DateOnly Expiry,
    decimal TickSize,
    decimal TickValue,
    int PriceDecimals,
    string Sector);

/// <summary>
/// One product's row in the product picker (REQUIREMENTS.md FR-55). Prices are integer ticks; <see cref="Bid"/> and
/// <see cref="Ask"/> are the book's best prices when the book is known, else the quote stream's. It needs trades and
/// quotes only, never depth, so the Overview tab can show every product (REQUIREMENTS.md FR-57): the latest order-flow signal,
/// how many fired in the last 15 minutes, and the regime per timeframe (FR-56).
/// </summary>
public sealed record MarketSummaryDto(
    long? Last,
    long? Bid,
    long? Ask,
    long? SessionOpen,
    long? SessionHigh,
    long? SessionLow,
    long SessionVolume,
    long CumulativeDelta,
    long Delta60s,
    double TradeRate,
    long? LastTradeMs,
    OrderFlowSignal? LatestSignal = null,
    int Signals15m = 0,
    IReadOnlyList<RegimeDto>? Regimes = null);

/// <summary>
/// The status chip of REQUIREMENTS.md FR-4: LIVE, REPLAY or SIMULATED when healthy, DEGRADED while a dropped-trade gap
/// is open or a minute repaired from a bar is still in view, else STALE or RECOVERING (ARCHITECTURE.md D-32, D-33).
/// </summary>
public sealed record StatusDto
{
    public required string Code { get; init; }

    public required string Provenance { get; init; }

    public required bool Connected { get; init; }

    public required bool BookKnown { get; init; }

    /// <summary>Whether depth is being received for this product; false while nobody watches it (REQUIREMENTS.md FR-54).</summary>
    public bool DepthSubscribed { get; init; } = true;

    public required long Epoch { get; init; }

    public long? LastEventAgeMs { get; init; }

    public long? CoveredLow { get; init; }

    public long? CoveredHigh { get; init; }

    public int LevelsPerSide { get; init; }

    public required string SessionId { get; init; }

    public required bool ExchangeOpen { get; init; }

    /// <summary>Known share of the last 10 slices across the covered range, 0–1.</summary>
    public double RecentCoverage { get; init; }

    public long DroppedWhileUnknown { get; init; }

    public long DuplicateTrades { get; init; }

    public long RejectedEvents { get; init; }

    /// <summary>Of <see cref="RejectedEvents"/>, those stamped more than 60 s after they were received: a clock problem.</summary>
    public long ClockAheadRejectedEvents { get; init; }

    public long BookResets { get; init; }

    /// <summary>
    /// Exchange time of the first dropped trade. The contract stays DEGRADED, and the badge reads
    /// "data missing since" this time. Cleared by a resubscribe depth snapshot or the next session (D-32).
    /// A connected status does not clear it.
    /// </summary>
    public long? MissingSinceMs { get; init; }

    /// <summary>
    /// False after a drop resets the CVD anchor. A one-minute bar has no aggressor, so CVD stays unknown until
    /// the next session or a fresh resubscribe snapshot. The repair itself does not make it known (D-33).
    /// </summary>
    public bool CvdKnown { get; init; } = true;

    /// <summary>
    /// True while the session profile still holds a minute filled from a closed bar. The chip stays DEGRADED
    /// for that, for an open hole, or while a repair is in flight. Rolling profiles keep their own flags (D-33).
    /// </summary>
    public bool Approximate { get; init; }
}

/// <summary>One slice: <c>C</c> is flat [priceTicks, bidTimeWeighted, askTimeWeighted, knownMs, …] per covered price.</summary>
public sealed record HeatColumnDto(long T, int D, IReadOnlyList<double> C);

public sealed record BarDto(long T, int D, long? O, long? H, long? L, long? C, long V, long Bv, long Sv, int N);

/// <summary>Closed points are [timeMs, value…]; a missing value (for example MACD signal in warmup) is null.</summary>
public sealed record IndicatorDto
{
    public required string Id { get; init; }

    public required string Label { get; init; }

    public required string Kind { get; init; }

    public required int Tf { get; init; }

    public required int Warmup { get; init; }

    public required int Seen { get; init; }

    public required bool Ready { get; init; }

    public required IReadOnlyList<IReadOnlyList<double?>> Points { get; init; }

    public IReadOnlyList<double?>? Dev { get; init; }
}

public sealed record ProfileDto
{
    public required string Window { get; init; }

    /// <summary>[priceTicks, volume] pairs, ascending price.</summary>
    public required IReadOnlyList<IReadOnlyList<long>> Bins { get; init; }

    public required long Total { get; init; }

    public long? Poc { get; init; }

    public long? Vah { get; init; }

    public long? Val { get; init; }

    public double? VaFraction { get; init; }

    public long? PartialSinceMs { get; init; }

    /// <summary>Dropped-trade holes in this window, each <c>[sinceMs, untilMs]</c>. <c>untilMs</c> is null while the gap is open (D-32).</summary>
    public IReadOnlyList<IReadOnlyList<long?>> MissingRanges { get; init; } = [];

    /// <summary>Minutes filled from a closed bar, each <c>[sinceMs, untilMs]</c>. Volume there is approximate (D-33).</summary>
    public IReadOnlyList<IReadOnlyList<long?>> ApproximateRanges { get; init; } = [];

    /// <summary>High-volume nodes, in ticks (REQUIREMENTS.md FR-50).</summary>
    public IReadOnlyList<long> Hvn { get; init; } = [];

    /// <summary>Low-volume nodes, in ticks (REQUIREMENTS.md FR-50).</summary>
    public IReadOnlyList<long> Lvn { get; init; } = [];
}

/// <summary>
/// One footprint bar (REQUIREMENTS.md FR-41). <c>C</c> is flat: [price, bidVolume, askVolume, imbalanceFlag, …] where the
/// flag is +1 for a diagonal buy imbalance, −1 for a sell imbalance and 0 for none.
/// </summary>
public sealed record FootprintDto(
    long T,
    long D,
    long? O,
    long? H,
    long? L,
    long? Cl,
    long V,
    long Delta,
    long MaxDelta,
    long MinDelta,
    IReadOnlyList<long> C,
    bool Missing = false,
    bool Approximate = false);

/// <summary>
/// The order-flow block of a snapshot or delta (REQUIREMENTS.md FR-41–FR-52). In a snapshot every list is complete; in a
/// delta <see cref="Footprints"/>, <see cref="CvdPoints"/> and <see cref="Signals"/> hold only what is new since the
/// previous delta, and the rest is current state.
/// </summary>
public sealed record OrderFlowDto
{
    public required long Cvd { get; init; }

    /// <summary>[bar end ms, session CVD at close] per footprint bar.</summary>
    public required IReadOnlyList<IReadOnlyList<long>> CvdPoints { get; init; }

    public required IReadOnlyList<FootprintDto> Footprints { get; init; }

    public FootprintDto? DevelopingFootprint { get; init; }

    public required IReadOnlyList<OrderFlowSignal> Signals { get; init; }

    public required long LastSignalId { get; init; }

    public required IReadOnlyList<IcebergReading> Icebergs { get; init; }

    public required IReadOnlyList<ImbalanceZone> Zones { get; init; }

    public required IReadOnlyList<UnfinishedAuction> UnfinishedAuctions { get; init; }

    public required IReadOnlyList<KeyLevel> KeyLevels { get; init; }

    public required TpoSnapshot Tpo { get; init; }

    public required int FootprintSeconds { get; init; }
}

public sealed record VwapDto(double? Vwap, double? StdDev, long Volume, bool Partial, string? Anchor);

public sealed record LadderDto(IReadOnlyList<IReadOnlyList<long>> Bids, IReadOnlyList<IReadOnlyList<long>> Asks);

/// <summary>
/// One live execution on the tape (REQUIREMENTS.md FR-59, ARCHITECTURE.md D-34). <see cref="Aggressor"/> is <c>Bid</c> when
/// the buyer lifted the offer and <c>Ask</c> when the seller hit the bid. History warmup is not represented.
/// </summary>
public sealed record PrintDto
{
    public required long SourceTimeMs { get; init; }

    public required long PriceTicks { get; init; }

    public required long Quantity { get; init; }

    public required string Aggressor { get; init; }

    /// <summary>Monotonic for the engine. A delta includes only sequences above the published watermark.</summary>
    public required long Sequence { get; init; }
}

public sealed record OverlayLevelDto(long PriceTicks, decimal Price, string Label, string Kind);

public sealed record OverlayDto
{
    public required long Version { get; init; }

    public required string Publisher { get; init; }

    public required long GeneratedAtMs { get; init; }

    public required long AsOfMs { get; init; }

    public required long ExpiresAtMs { get; init; }

    public required long AvailableAtMs { get; init; }

    public required bool Expired { get; init; }

    public required double SourceCoverage { get; init; }

    public required IReadOnlyList<OverlayLevelDto> Levels { get; init; }

    public required string Rationale { get; init; }

    public required IReadOnlyList<string> QualityFlags { get; init; }
}

/// <summary>A coherent state for one instrument: what a browser receives on subscribe (INTERFACES.md D.2).</summary>
public sealed record DashboardSnapshot
{
    public required string Root { get; init; }

    /// <summary>The last publication sequence this snapshot includes; deltas continue at Seq + 1.</summary>
    public required long Seq { get; init; }

    public required long ServerTimeMs { get; init; }

    public required InstrumentInfo Instrument { get; init; }

    public required StatusDto Status { get; init; }

    public required IReadOnlyList<HeatColumnDto> Heat { get; init; }

    public required IReadOnlyList<BarDto> Bars { get; init; }

    public BarDto? DevelopingBar { get; init; }

    /// <summary>Closed one-minute bars inside the requested history, the source the chart re-aggregates.</summary>
    public IReadOnlyList<BarDto> MinuteBars { get; init; } = [];

    public BarDto? DevelopingMinute { get; init; }

    /// <summary>Closed one-minute heatmap columns. Integrals are combined, never averaged (REQUIREMENTS.md FR-12).</summary>
    public IReadOnlyList<HeatColumnDto> MinuteHeat { get; init; } = [];

    public HeatColumnDto? DevelopingMinuteHeat { get; init; }

    /// <summary>Key levels with how many distinct approaches have reached them.</summary>
    public IReadOnlyList<LevelTouch> LevelTouches { get; init; } = [];

    /// <summary>
    /// Live prints retained for the tape (REQUIREMENTS.md FR-59, ARCHITECTURE.md D-34). Oldest dropped at the cap.
    /// A delta carries only sequences above the last published watermark for the current epoch.
    /// </summary>
    public IReadOnlyList<PrintDto> Prints { get; init; } = [];

    public required IReadOnlyList<IndicatorDto> Indicators { get; init; }

    public required IReadOnlyList<ProfileDto> Profiles { get; init; }

    public required VwapDto Vwap { get; init; }

    public required LiquiditySnapshot Liquidity { get; init; }

    public required LadderDto Ladder { get; init; }

    public OverlayDto? Overlay { get; init; }

    public long? SessionHigh { get; init; }

    public long? SessionLow { get; init; }

    /// <summary>Executions at or before this time came from history (warmup), not from the live session.</summary>
    public long? HistoryWatermarkMs { get; init; }

    /// <summary>
    /// The range zones of each regime timeframe over the retained bars, oldest first (REQUIREMENTS.md FR-75): one set per
    /// <c>Engine:Regime:TimeframesSeconds</c> entry, empty when nothing has ranged.
    /// </summary>
    public IReadOnlyList<RangeZoneSetDto> RangeZones { get; init; } = [];

    public required OrderFlowDto OrderFlow { get; init; }
}

/// <summary>What changed since the previous publication. A client that sees a gap in Seq re-subscribes (REQUIREMENTS.md NFR-5).</summary>
public sealed record DashboardDelta
{
    public required string Root { get; init; }

    public required long Seq { get; init; }

    public required long ServerTimeMs { get; init; }

    public required StatusDto Status { get; init; }

    public required IReadOnlyList<HeatColumnDto> Heat { get; init; }

    public required IReadOnlyList<BarDto> Bars { get; init; }

    public BarDto? DevelopingBar { get; init; }

    /// <summary>Closed one-minute bars inside the requested history, the source the chart re-aggregates.</summary>
    public IReadOnlyList<BarDto> MinuteBars { get; init; } = [];

    public BarDto? DevelopingMinute { get; init; }

    /// <summary>Closed one-minute heatmap columns. Integrals are combined, never averaged (REQUIREMENTS.md FR-12).</summary>
    public IReadOnlyList<HeatColumnDto> MinuteHeat { get; init; } = [];

    public HeatColumnDto? DevelopingMinuteHeat { get; init; }

    /// <summary>Key levels with how many distinct approaches have reached them.</summary>
    public IReadOnlyList<LevelTouch> LevelTouches { get; init; } = [];

    /// <summary>
    /// Live prints retained for the tape (REQUIREMENTS.md FR-59, ARCHITECTURE.md D-34). Oldest dropped at the cap.
    /// A delta carries only sequences above the last published watermark for the current epoch.
    /// </summary>
    public IReadOnlyList<PrintDto> Prints { get; init; } = [];

    public required IReadOnlyList<IndicatorDto> Indicators { get; init; }

    public required IReadOnlyList<ProfileDto> Profiles { get; init; }

    public required VwapDto Vwap { get; init; }

    public required LiquiditySnapshot Liquidity { get; init; }

    public required LadderDto Ladder { get; init; }

    public OverlayDto? Overlay { get; init; }

    public long? SessionHigh { get; init; }

    public long? SessionLow { get; init; }

    /// <summary>
    /// Every timeframe's range zones, as on the snapshot, when any changed since the previous publication; null when
    /// none did, so the client keeps the zones it holds (REQUIREMENTS.md FR-75).
    /// </summary>
    public IReadOnlyList<RangeZoneSetDto>? RangeZones { get; init; }

    public required OrderFlowDto OrderFlow { get; init; }
}

/// <summary>
/// The read-only analytics an agent needs to write an overlay (INTERFACES.md Interface C, REQUIREMENTS.md UC-5).
/// Holds no raw book events, no credentials and nothing that can trade.
/// </summary>
public sealed record AgentContext
{
    public required InstrumentInfo Instrument { get; init; }

    public required long AsOfMs { get; init; }

    public required StatusDto Status { get; init; }

    public decimal? LastPrice { get; init; }

    public decimal? SessionHigh { get; init; }

    public decimal? SessionLow { get; init; }

    public required VwapDto Vwap { get; init; }

    /// <summary>Latest closed value of each ready indicator, keyed by indicator ID, in price units (RSI 0–100).</summary>
    public required IReadOnlyDictionary<string, IReadOnlyList<double?>> Indicators { get; init; }

    public required IReadOnlyList<ProfileDto> Profiles { get; init; }

    public required LiquiditySnapshot Liquidity { get; init; }

    /// <summary>The last 30 one-minute bars.</summary>
    public required IReadOnlyList<BarDto> RecentMinuteBars { get; init; }

    /// <summary>The latest order-flow signals, newest last; prices in ticks like everything in a signal.</summary>
    public required IReadOnlyList<OrderFlowSignal> RecentSignals { get; init; }

    public required IReadOnlyList<IcebergReading> Icebergs { get; init; }

    public required IReadOnlyList<KeyLevel> KeyLevels { get; init; }

    public required long Cvd { get; init; }
}

/// <summary>Last price, the session change, where price sits versus VWAP, and the nearest key level.</summary>
public sealed record InstrumentQuote(
    InstrumentInfo Instrument,
    StatusDto Status,
    long? LastTicks,
    long? OpenTicks,
    long? ChangeTicks,
    double? VwapTicks,
    double? VwapStdDev,
    string? NearestLevel,
    long? NearestDistanceTicks,
    int NearestTouches,
    bool NearestIsThirdTouch,
    IReadOnlyList<LevelTouch> Levels);
