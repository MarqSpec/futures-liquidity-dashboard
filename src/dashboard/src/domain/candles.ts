import type { Bar } from "../api/schemas.ts";

/** One OHLC candle in ticks. */
export interface Candle {
  readonly t: number;
  readonly d: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly bv: number;
  readonly sv: number;
  /** True for the candle still forming. */
  readonly developing: boolean;
}

/**
 * Rolls the slice bars (1 s on the wire) and the developing bar up into candles of `bucketMs` (1 minute by
 * default). Empty bars (null OHLC) are skipped; a bucket with no trades has no candle. A candle whose bucket has
 * not ended by `nowMs` is marked developing.
 */
export function aggregateCandles(
  bars: readonly Bar[],
  developing: Bar | null,
  nowMs: number,
  bucketMs = 60_000,
): Candle[] {
  type Open = Omit<Candle, "d" | "developing">;
  const buckets = new Map<number, Open>();
  const all = developing ? [...bars, developing] : bars;
  for (const bar of all) {
    if (bar.o == null || bar.h == null || bar.l == null || bar.c == null) {
      continue;
    }
    const t = Math.floor(bar.t / bucketMs) * bucketMs;
    const open = buckets.get(t);
    buckets.set(
      t,
      open
        ? {
            t,
            o: open.o,
            h: Math.max(open.h, bar.h),
            l: Math.min(open.l, bar.l),
            c: bar.c,
            v: open.v + bar.v,
            bv: open.bv + bar.bv,
            sv: open.sv + bar.sv,
          }
        : { t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, bv: bar.bv, sv: bar.sv },
    );
  }
  // A Map iterates in insertion order, and bars arrive in time order.
  return [...buckets.values()].map((c) => ({ ...c, d: bucketMs, developing: c.t + bucketMs > nowMs }));
}
