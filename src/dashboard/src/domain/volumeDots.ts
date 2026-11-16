import { colors } from "../theme.ts";

/** The label drawn on the region at or before `historyWatermarkMs` (REQUIREMENTS.md FR-61). */
export const HISTORY_WITHOUT_TAPE = "history — no tape dots";

/** Drawn where retained prints begin, after any warmup or gap the buffer no longer holds. */
export const TAPE_STARTS_HERE = "tape starts here";

/** A last-trade flash is bright for this long, then gone (REQUIREMENTS.md FR-60). */
export const TRADE_FLASH_MS = 2_000;

/** One live print from the wire (REQUIREMENTS.md FR-59). */
export interface TapePrint {
  readonly sourceTimeMs: number;
  readonly priceTicks: number;
  readonly quantity: number;
  readonly aggressor: string;
  readonly sequence: number;
}

/** One dot: the VWAP of the prints that landed in one time×price bucket. */
export interface VolumeDot {
  readonly timeMs: number;
  readonly priceTicks: number;
  readonly quantity: number;
  readonly aggressor: "Bid" | "Ask";
  readonly radius: number;
}

const MIN_RADIUS = 2.5;
const MAX_RADIUS = 10;

/** Time buckets are at least a dot diameter wide, so neighbouring dots do not stack on one pixel. */
const DOT_BUCKET_PX = MAX_RADIUS * 2;

/**
 * Aggregates live prints into zoom-aware time×price buckets. A print at or before `historyWatermarkMs` is
 * omitted, and so is one below `minQuantity`. The dot sits on the bucket VWAP. Radius is log-scaled to the
 * largest bucket still drawn. Buy aggressor (`Bid`) and sell aggressor (`Ask`) stay separate.
 */
export function volumeDots(input: {
  readonly prints: readonly TapePrint[];
  readonly historyWatermarkMs: number | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly plotWidthPx: number;
  readonly priceSpanTicks: number;
  readonly plotHeightPx: number;
  readonly minQuantity: number;
}): VolumeDot[] {
  const span = Math.max(1, input.endMs - input.startMs);
  const bucketMs = Math.max(1, (span / Math.max(1, input.plotWidthPx)) * DOT_BUCKET_PX);
  const bucketTicks = Math.max(1, Math.round(Math.max(1, input.priceSpanTicks) / Math.max(1, input.plotHeightPx)));
  const groups = new Map<string, { qty: number; price: number; time: number; aggressor: "Bid" | "Ask" }>();

  for (const print of input.prints) {
    if (input.historyWatermarkMs !== null && print.sourceTimeMs <= input.historyWatermarkMs) {
      continue;
    }
    if (print.quantity < input.minQuantity) {
      continue;
    }
    if (print.sourceTimeMs < input.startMs || print.sourceTimeMs > input.endMs) {
      continue;
    }
    const side = print.aggressor === "Bid" || print.aggressor === "Ask" ? print.aggressor : null;
    if (side === null) {
      continue;
    }
    const tBin = Math.floor(print.sourceTimeMs / bucketMs);
    const pBin = Math.floor(print.priceTicks / bucketTicks);
    const key = `${tBin}|${pBin}|${side}`;
    const acc = groups.get(key) ?? { qty: 0, price: 0, time: 0, aggressor: side };
    acc.qty += print.quantity;
    acc.price += print.priceTicks * print.quantity;
    acc.time += print.sourceTimeMs * print.quantity;
    groups.set(key, acc);
  }

  let maxQty = 1;
  for (const acc of groups.values()) {
    maxQty = Math.max(maxQty, acc.qty);
  }
  const denom = Math.log1p(maxQty);
  const dots: VolumeDot[] = [];
  for (const acc of groups.values()) {
    if (acc.qty <= 0) continue;
    dots.push({
      timeMs: acc.time / acc.qty,
      priceTicks: acc.price / acc.qty,
      quantity: acc.qty,
      aggressor: acc.aggressor,
      radius: MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * (Math.log1p(acc.qty) / denom),
    });
  }
  dots.sort((a, b) => a.timeMs - b.timeMs || a.priceTicks - b.priceTicks || (a.aggressor === b.aggressor ? 0 : a.aggressor === "Bid" ? -1 : 1));
  return dots;
}

/**
 * When retained prints do not cover the window, candles fill the earlier part. The boundary is the oldest live
 * print, or the watermark when the buffer holds none. Null means the whole window is the fallback.
 */
export function tapeBoundaryMs(watermarkMs: number | null, prints: readonly { readonly sourceTimeMs: number }[]): number | null {
  let oldest: number | null = null;
  for (const print of prints) {
    if (watermarkMs !== null && print.sourceTimeMs <= watermarkMs) continue;
    if (oldest === null || print.sourceTimeMs < oldest) oldest = print.sourceTimeMs;
  }
  if (oldest !== null) return oldest;
  return watermarkMs;
}

/**
 * True when this candle is the price mark. Candles on draws every candle. Candles off draws only the part the tape
 * does not cover. Both off leaves the boundary unset, so the candle path stays and the chart is not blank.
 */
export function candleIsPriceMark(candleStartMs: number, showCandles: boolean, tapeStartMs: number | null): boolean {
  if (showCandles || tapeStartMs === null) return true;
  return candleStartMs < tapeStartMs;
}

/** 1 when the print just arrived on the client, 0 once `TRADE_FLASH_MS` of client time has passed. */
export function tradeFlashAlpha(nowMs: number, arrivedAtMs: number): number {
  const age = nowMs - arrivedAtMs;
  if (age < 0) return 1;
  if (age >= TRADE_FLASH_MS) return 0;
  return 1 - age / TRADE_FLASH_MS;
}

/** Buyer lifting the offer is aggressor-buy (the blue `up`); seller hitting the bid is aggressor-sell (the grey `down`). */
export function aggressorColor(side: "Bid" | "Ask"): string {
  return side === "Bid" ? colors.aggressorBuy : colors.aggressorSell;
}
