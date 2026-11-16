import { z } from "zod";

// The browser contract (INTERFACES.md Interface D.2), mirrored from the C# wire types in
// MarqSpec.FuturesLiquidityDashboard.Core/Engine/WireModels.cs. Objects are not strict, so a field the server adds
// later is dropped rather than failing the parse; a missing or mistyped field fails it.

/** A JSON double. The API allows named floating-point literals, so NaN and ±Infinity arrive as strings. */
const dbl = z
  .union([z.number(), z.enum(["NaN", "Infinity", "-Infinity"])])
  .transform((v) => (typeof v === "number" ? v : Number.NaN));

/** A long: ticks, milliseconds or contracts. */
const long = z.number();

const pair = z.tuple([long, long]);

/** A compact flat number array whose length is a multiple of `stride`; checked cheaply, it can hold millions. */
function flat(stride: number) {
  return z.custom<readonly number[]>(
    (v) => Array.isArray(v) && v.length % stride === 0 && v.every((x) => typeof x === "number"),
    { message: `expected a flat number array with a stride of ${stride}` },
  );
}

export const signalKinds = [
  "Iceberg",
  "StackedImbalance",
  "UnfinishedAuction",
  "TrappedTraders",
  "CvdDivergence",
  "DeltaExhaustion",
  "Spoof",
  "LiquiditySweep",
  "SinglePrints",
] as const;

export type SignalKind = (typeof signalKinds)[number];

export const biasSchema = z.enum(["Neutral", "Bullish", "Bearish"]).catch("Neutral");
export type Bias = z.infer<typeof biasSchema>;

export const instrumentInfoSchema = z.object({
  root: z.string(),
  name: z.string(),
  exchange: z.string(),
  contractId: z.string(),
  expiry: z.string(),
  tickSize: z.number().positive(),
  tickValue: z.number(),
  priceDecimals: z.number().int().min(0).max(8),
  /** The product group the picker files it under; an older server sends none. */
  sector: z.string().default("Other"),
});

export const statusSchema = z.object({
  code: z.string(),
  provenance: z.string(),
  connected: z.boolean(),
  bookKnown: z.boolean(),
  epoch: long,
  lastEventAgeMs: long.nullish(),
  coveredLow: long.nullish(),
  coveredHigh: long.nullish(),
  levelsPerSide: z.number().default(0),
  sessionId: z.string(),
  exchangeOpen: z.boolean(),
  recentCoverage: dbl.default(0),
  droppedWhileUnknown: long.default(0),
  duplicateTrades: long.default(0),
  rejectedEvents: long.default(0),
  bookResets: long.default(0),
  /** Whether the server is receiving depth for this product; an older server pulled depth for every product. */
  depthSubscribed: z.boolean().default(true),
  /** Exchange time of the open dropped-trade gap. The chip stays DEGRADED until the post-subscribe book or the next session (D-32). */
  missingSinceMs: long.nullish(),
  /** False after a drop resets CVD. A minute bar has no aggressor, so this stays false until the next session or a fresh resubscribe (D-33). */
  cvdKnown: z.boolean().default(true),
  /** True while a profile still holds minutes filled from a closed bar. The contract stays DEGRADED, never LIVE (D-33). */
  approximate: z.boolean().default(false),
});

export const heatColumnSchema = z.object({ t: long, d: z.number(), c: flat(4) });

export const barSchema = z.object({
  t: long,
  d: z.number(),
  o: long.nullish(),
  h: long.nullish(),
  l: long.nullish(),
  c: long.nullish(),
  v: long,
  bv: long,
  sv: long,
  n: z.number(),
});

export const indicatorSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  tf: z.number(),
  warmup: z.number(),
  seen: z.number(),
  ready: z.boolean(),
  points: z.array(z.array(z.number().nullable())),
  dev: z.array(z.number().nullable()).nullish(),
});

export const profileSchema = z.object({
  window: z.string(),
  bins: z.array(pair),
  total: long,
  poc: long.nullish(),
  vah: long.nullish(),
  val: long.nullish(),
  vaFraction: dbl.nullish(),
  partialSinceMs: long.nullish(),
  /** Dropped-trade holes still in this window. Each pair is [sinceMs, untilMs]; untilMs is null while the gap is open. */
  missingRanges: z.array(z.tuple([long, long.nullish()])).default([]),
  /** Minutes filled from a closed one-minute bar. Each pair is [sinceMs, untilMs]. Volume there is approximate (D-33). */
  approximateRanges: z.array(z.tuple([long, long.nullish()])).default([]),
  hvn: z.array(long).default([]),
  lvn: z.array(long).default([]),
});

export const footprintSchema = z.object({
  t: long,
  d: long,
  o: long.nullish(),
  h: long.nullish(),
  l: long.nullish(),
  cl: long.nullish(),
  v: long,
  delta: long,
  maxDelta: long,
  minDelta: long,
  c: flat(4),
  /** Set when this bar overlaps a dropped-trade range and not an approximate repair. Absent on an older server (D-32). */
  missing: z.boolean().optional(),
  /** Set when this bar's volume came from a closed minute bar. Absent on an older server (D-33). */
  approximate: z.boolean().optional(),
});

export const signalSchema = z.object({
  id: long,
  kind: z.string(),
  bias: biasSchema,
  timeMs: long,
  priceTicks: long,
  priceHighTicks: long,
  strength: dbl,
  label: z.string(),
  detail: z.string(),
});

export const icebergSchema = z.object({
  side: z.string(),
  priceTicks: long,
  traded: long,
  displayed: long,
  peakDisplayed: long,
  refills: z.number(),
  averageRefill: long,
  hiddenEstimate: long,
  confidence: dbl,
  firstSeenMs: long,
  lastFillMs: long,
  active: z.boolean(),
});

export const zoneSchema = z.object({
  bias: biasSchema,
  lowTicks: long,
  highTicks: long,
  levels: z.number(),
  averageRatio: dbl,
});

export const unfinishedAuctionSchema = z.object({
  priceTicks: long,
  atHigh: z.boolean(),
  barStartMs: long,
  bidVolume: long,
  askVolume: long,
});

export const keyLevelSchema = z.object({
  name: z.string(),
  priceTicks: long,
  isHigh: z.boolean(),
  sessionId: z.string().nullish(),
  asOfMs: long.nullish(),
});

export const levelTouchSchema = z.object({
  name: z.string(),
  priceTicks: long,
  isHigh: z.boolean(),
  touches: z.number().int(),
  lastTouchMs: long.nullish(),
  isThirdTouch: z.boolean().default(false),
  sessionId: z.string().nullish(),
  asOfMs: long.nullish(),
});

/** One live print (REQUIREMENTS.md FR-59). History warmup is not in this array. */
export const printSchema = z.object({
  sourceTimeMs: long,
  priceTicks: long,
  quantity: long,
  aggressor: z.string(),
  sequence: long,
});

export const tpoSchema = z.object({
  rowTicks: z.number(),
  periodMinutes: z.number(),
  sessionOpenMs: long.nullish(),
  rows: z.array(z.object({ priceTicks: long, letters: z.string() })),
  pocTicks: long.nullish(),
  singlePrints: z.array(z.object({ lowTicks: long, highTicks: long, letter: z.string(), tail: z.boolean() })),
  partialSinceMs: long.nullish(),
});

export const orderFlowSchema = z.object({
  cvd: long,
  cvdPoints: z.array(pair),
  footprints: z.array(footprintSchema),
  developingFootprint: footprintSchema.nullish(),
  signals: z.array(signalSchema),
  lastSignalId: long,
  icebergs: z.array(icebergSchema),
  zones: z.array(zoneSchema),
  unfinishedAuctions: z.array(unfinishedAuctionSchema),
  keyLevels: z.array(keyLevelSchema),
  tpo: tpoSchema,
  footprintSeconds: z.number(),
});

export const vwapSchema = z.object({
  vwap: dbl.nullish(),
  stdDev: dbl.nullish(),
  volume: long,
  partial: z.boolean(),
  anchor: z.string().nullish(),
});

export const ladderSchema = z.object({ bids: z.array(pair), asks: z.array(pair) });

const flowTotalsSchema = z.object({
  bidAdded: long,
  bidPulled: long,
  bidFilled: long,
  askAdded: long,
  askPulled: long,
  askFilled: long,
});

export const liquiditySchema = z.object({
  bookKnown: z.boolean(),
  bestBid: long.nullish(),
  bestAsk: long.nullish(),
  bestBidQuantity: long.nullish(),
  bestAskQuantity: long.nullish(),
  spreadTicks: long.nullish(),
  microprice: dbl.nullish(),
  depth: z.array(z.object({ levels: z.number(), bid: long, ask: long, imbalance: dbl.nullish() })),
  flow10s: flowTotalsSchema,
  flow60s: flowTotalsSchema,
  cumulativeDelta: long,
  delta60s: long,
  tradeRate: dbl,
  sessionVolume: long,
  walls: z.array(z.object({ side: z.string(), priceTicks: long, quantity: long, ageMs: long })),
  quoteTimeMs: long.nullish(),
  quoteStale: z.boolean().default(false),
});

export const overlaySchema = z.object({
  version: long,
  publisher: z.string(),
  generatedAtMs: long,
  asOfMs: long,
  expiresAtMs: long,
  availableAtMs: long,
  expired: z.boolean(),
  sourceCoverage: dbl,
  levels: z.array(z.object({ priceTicks: long, price: z.number(), label: z.string(), kind: z.string() })),
  rationale: z.string(),
  qualityFlags: z.array(z.string()),
});

const publication = {
  root: z.string(),
  seq: long,
  serverTimeMs: long,
  status: statusSchema,
  heat: z.array(heatColumnSchema),
  bars: z.array(barSchema),
  developingBar: barSchema.nullish(),
  minuteBars: z.array(barSchema).default([]),
  developingMinute: barSchema.nullish(),
  minuteHeat: z.array(heatColumnSchema).default([]),
  developingMinuteHeat: heatColumnSchema.nullish(),
  levelTouches: z.array(levelTouchSchema).default([]),
  prints: z.array(printSchema).default([]),
  indicators: z.array(indicatorSchema),
  profiles: z.array(profileSchema),
  vwap: vwapSchema,
  liquidity: liquiditySchema,
  ladder: ladderSchema,
  overlay: overlaySchema.nullish(),
  sessionHigh: long.nullish(),
  sessionLow: long.nullish(),
  orderFlow: orderFlowSchema,
};

export const snapshotSchema = z.object({
  ...publication,
  instrument: instrumentInfoSchema,
  historyWatermarkMs: long.nullish(),
});

export const deltaSchema = z.object(publication);

/** How a product's price is moving on one bar timeframe; a trend this client does not know reads as Unknown. */
export const regimeTrends = ["Unknown", "Ranging", "Transition", "TrendingUp", "TrendingDown"] as const;
export type RegimeTrend = (typeof regimeTrends)[number];

const nullableDbl = dbl.nullish().transform((v) => v ?? null);
const nullableLong = long.nullish().transform((v) => v ?? null);

/** One timeframe's regime. Fields the server adds later (another regime kind) are dropped. */
export const regimeSchema = z.object({
  timeframeSeconds: z.number().int().positive(),
  trend: z.enum(regimeTrends).catch("Unknown"),
  ready: z.boolean().default(false),
  seenBars: z.number().int().default(0),
  warmupBars: z.number().int().default(0),
  adx: nullableDbl,
  efficiencyRatio: nullableDbl,
  emaFast: nullableDbl,
  emaSlow: nullableDbl,
  sinceMs: nullableLong,
});

/** The regimes array, kept tolerant: an entry this client cannot read is left out rather than failing the row. */
const regimesSchema = z
  .array(z.unknown())
  .transform((entries) =>
    entries.flatMap((entry) => {
      const parsed = regimeSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  );

/** One product's session numbers on GET /api/instruments; prices are integer ticks. */
export const marketSummarySchema = z.object({
  last: nullableLong,
  bid: nullableLong,
  ask: nullableLong,
  sessionOpen: nullableLong,
  sessionHigh: nullableLong,
  sessionLow: nullableLong,
  sessionVolume: long.default(0),
  cumulativeDelta: long.default(0),
  delta60s: long.default(0),
  tradeRate: dbl.default(0),
  lastTradeMs: nullableLong,
  /** The newest order-flow signal, or null. */
  latestSignal: signalSchema.nullish().transform((v) => v ?? null),
  /** How many signals fired in the last 15 minutes. */
  signals15m: z.number().int().default(0),
  /** One regime per configured bar timeframe, by timeframe (by default 300 and 900 seconds). */
  regimes: regimesSchema.default([]),
});

/** The summary of a product nothing has traded in yet, and what an older server's answer (with none) reads as. */
export const emptyMarketSummary: MarketSummary = {
  last: null,
  bid: null,
  ask: null,
  sessionOpen: null,
  sessionHigh: null,
  sessionLow: null,
  sessionVolume: 0,
  cumulativeDelta: 0,
  delta60s: 0,
  tradeRate: 0,
  lastTradeMs: null,
  latestSignal: null,
  signals15m: 0,
  regimes: [],
};

export const instrumentSummariesSchema = z.array(
  z.object({
    instrument: instrumentInfoSchema,
    status: statusSchema,
    summary: marketSummarySchema.default(() => ({ ...emptyMarketSummary, regimes: [] })),
    lastTicks: long.nullish(),
    openTicks: long.nullish(),
    changeTicks: long.nullish(),
    vwapTicks: dbl.nullish(),
    vwapStdDev: dbl.nullish(),
    nearestLevel: z.string().nullish(),
    nearestDistanceTicks: long.nullish(),
    nearestTouches: z.number().default(0),
    nearestIsThirdTouch: z.boolean().default(false),
    levels: z.array(levelTouchSchema).default([]),
  }),
);

/** SetWatchlist's answer: the roots the server now pulls depth for on this connection's behalf, and the rest. */
export const watchlistResultSchema = z.object({
  depth: z.array(z.string()),
  refused: z.array(z.string()),
});

export type InstrumentInfo = z.infer<typeof instrumentInfoSchema>;
export type Status = z.infer<typeof statusSchema>;
export type HeatColumn = z.infer<typeof heatColumnSchema>;
export type Bar = z.infer<typeof barSchema>;
export type Indicator = z.infer<typeof indicatorSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Footprint = z.infer<typeof footprintSchema>;
export type Signal = z.infer<typeof signalSchema>;
export type Iceberg = z.infer<typeof icebergSchema>;
export type Zone = z.infer<typeof zoneSchema>;
export type UnfinishedAuction = z.infer<typeof unfinishedAuctionSchema>;
export type KeyLevel = z.infer<typeof keyLevelSchema>;
export type LevelTouch = z.infer<typeof levelTouchSchema>;
export type Print = z.infer<typeof printSchema>;
export type Tpo = z.infer<typeof tpoSchema>;
export type OrderFlow = z.infer<typeof orderFlowSchema>;
export type Vwap = z.infer<typeof vwapSchema>;
export type Ladder = z.infer<typeof ladderSchema>;
export type Liquidity = z.infer<typeof liquiditySchema>;
export type Overlay = z.infer<typeof overlaySchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Delta = z.infer<typeof deltaSchema>;
export type Regime = z.infer<typeof regimeSchema>;
export type MarketSummary = z.infer<typeof marketSummarySchema>;
export type InstrumentSummary = z.infer<typeof instrumentSummariesSchema>[number];
export type WatchlistResult = z.infer<typeof watchlistResultSchema>;
