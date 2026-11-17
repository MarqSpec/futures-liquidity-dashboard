// The contrast floors of REQUIREMENTS.md NFR-8: which tokens are text and which are lines, and the surfaces they hold on.
// contrast.test.ts holds every theme default to them; the chart-colour registry reads each role's floor from them.
// reference: REQUIREMENTS.md NFR-8 (accessibility); the thresholds are WCAG 2.2 SC 1.4.3 and SC 1.4.11.

/** The six tonal surfaces every text and line token is held on. */
export const SURFACES = [
  "surface-lowest",
  "surface",
  "surface-low",
  "surface-container",
  "surface-high",
  "surface-highest",
] as const;

/** Text and text-like marks: 4.5:1 on every surface. */
export const TEXT = [
  "on-surface",
  "on-surface-variant",
  "on-surface-muted",
  "primary",
  "up",
  "down",
  "danger",
  "bid",
  "ask",
  "bid-strong",
  "ask-strong",
  "last-price",
  "status-live-text",
  "status-replay-text",
  "status-simulated",
  "error",
  "tpo-letter",
  "signal-marker",
] as const;

/** Lines and meaningful borders: 3:1 on every surface. */
export const GRAPHIC = [
  "outline",
  "vwap",
  "support",
  "reference",
  "crosshair",
  "node-hvn",
  "node-lvn",
  "node-neutral",
  "poc",
  "ema-10",
  "ema-13",
  "ema-24",
  "ema-48",
  "ema-200",
  "indicator-rsi",
  "indicator-macd",
  "indicator-macd-signal",
  "indicator-atr",
  "bias-bullish",
  "bias-bearish",
  "bias-neutral",
  "event-iceberg",
  "event-stacked-imbalance",
  "event-unfinished-auction",
  "event-trapped-traders",
  "event-cvd-divergence",
  "event-delta-exhaustion",
  "event-spoof",
  "event-liquidity-sweep",
  "event-single-prints",
  "event-failed-reclaim",
  "event-unknown",
  "price-line",
  // The warmup line, candles, CVD and volume are stroked marks, held to the line floor.
  "warmup",
  // A volume dot's edge by aggressor side, green buying and red selling, on every tab.
  "dot-outline-buy",
  "dot-outline-sell",
] as const;

export const TEXT_MINIMUM = 4.5;
export const GRAPHIC_MINIMUM = 3;

/** The token the Order Flow plot is painted on before anything else: the ground under the warmup band. */
export const BOOKMAP_STAGE = "surface-lowest";

/**
 * The warmup band is `warmup` at this alpha over the stage. The warmup candles, the dashed price step, the watermark
 * edge, the no-L2 caption and every guide drawn across it sit on that composite, so it is held to NFR-8's floors.
 * Was 0.28, which left `warmup` itself at 2.99:1 and 2.95:1 on it.
 */
export const WARMUP_BAND_ALPHA = 0.25;
