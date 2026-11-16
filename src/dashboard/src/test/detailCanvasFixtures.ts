import type { Profile } from "../api/schemas.ts";
import type { MainChartModel } from "../components/drawMainChart.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import { snapshotFixture } from "./fixtures.ts";

// Shared inputs for the Detail canvas tests: a quiet market at prices 80–120 and a small profile.

export const market = fromSnapshot(snapshotFixture(), 5, 0);
export const start = 1_700_000_000_000;
export const rising = { t: start, d: 60_000, o: 100, h: 110, l: 90, c: 105, v: 1, bv: 1, sv: 0, developing: false };
export const falling = { t: start + 60_000, d: 60_000, o: 105, h: 110, l: 88, c: 90, v: 1, bv: 0, sv: 1, developing: false };

/** A quiet market at prices 80–120: two candles, a VWAP with bands, a best bid and ask, no heat. */
export function quiet(overrides: Partial<MarketState> = {}): MarketState {
  return {
    ...market,
    serverTimeMs: start + 600_000,
    receivedAtMs: start + 600_000,
    historyWatermarkMs: null,
    prints: [],
    vwap: { ...market.vwap, vwap: 100, stdDev: 4, partial: false },
    vwapTrail: [
      [start, 99, 3],
      [start + 60_000, 100, 4],
    ],
    liquidity: { ...market.liquidity, bestBid: 95, bestAsk: 96, quoteStale: false },
    status: { ...market.status, code: "LIVE" },
    ...overrides,
  };
}

export function model(overrides: Partial<MainChartModel> = {}): MainChartModel {
  return {
    market: quiet(),
    candles: [rising, falling],
    startMs: start,
    endMs: start + 600_000,
    lowTicks: 80,
    highTicks: 120,
    heatmap: false,
    heatColumns: [],
    heatMode: "intensity",
    heatContrast: 1,
    heatScale: 1,
    showCandles: true,
    showVolumeDots: false,
    levelTouches: [],
    profile: null,
    emaIds: [],
    vwap: true,
    overlay: false,
    signals: [],
    isKindOn: () => true,
    ...overrides,
  };
}

export const profile: Profile = {
  window: "session",
  bins: [
    [96, 4],
    [98, 10],
    [100, 30],
    [102, 12],
    [110, 2],
  ],
  total: 58,
  poc: 100,
  vah: 102,
  val: 98,
  vaFraction: 0.7,
  partialSinceMs: null,
  missingRanges: [],
  approximateRanges: [],
  hvn: [100],
  lvn: [110],
};
