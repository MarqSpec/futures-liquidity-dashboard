import { READ_ONLY_TRAIL, bookmapFrame } from "../domain/bookmap.ts";
import type { BookmapDrawModel } from "../components/drawBookmap.ts";

// An Order Flow frame with something of every kind in it: warmup and live candles, a large two-sided dot, levels, a
// quote, an event, a failed reclaim and its guide, the COB and SVP. Volume and CVD are indicator-dock tabs.

export const bookmapSpec = { tickSize: 0.25, priceDecimals: 2 };

export function bookmapModel(overrides: Partial<BookmapDrawModel> = {}): BookmapDrawModel {
  const frame = bookmapFrame(1100, 640);
  const base: BookmapDrawModel = {
    frame,
    startMs: 0,
    endMs: 120_000,
    lowTicks: 90,
    highTicks: 120,
    heatColumns: [],
    heatMode: "intensity",
    heatDim: 0,
    heatContrast: 1,
    heatAutoContrast: true,
    heatLowPercentile: 5,
    heatHighPercentile: 95,
    historyWatermarkMs: 30_000,
    candles: [
      { t: 0, d: 60_000, o: 100, h: 104, l: 98, c: 101, v: 10, bv: 4, sv: 6, developing: false },
      { t: 60_000, d: 60_000, o: 101, h: 108, l: 100, c: 107, v: 20, bv: 14, sv: 6, developing: false },
    ],
    showCandles: true,
    showPriceLine: false,
    priceSteps: [],
    eventDotRadius: 4.5,
    dots: [
      { timeMs: 70_000, priceTicks: 105, buy: 80, sell: 20, total: 5_000, buyFraction: 0.8, radius: 9, label: true },
    ],
    levels: [
      { name: "PDH", priceTicks: 110, emphasis: "level" },
      { name: "HVN", priceTicks: 106, emphasis: "hvn" },
    ],
    emphasizeNodes: true,
    showBbo: true,
    bboStale: false,
    bestBid: 104,
    bestAsk: 105,
    showPnc: true,
    signals: [{ timeMs: 80_000, priceTicks: 107, kind: "LiquiditySweep", inferred: true }],
    reclaims: [
      { name: "PDH", levelTicks: 110, timeMs: 90_000, priceTicks: 108, extremeTicks: 116, isHigh: true },
    ],
    guide: {
      fromTicks: 113,
      toTicks: 100,
      targetName: "LVN",
      heading: READ_ONLY_TRAIL,
      detail: "Not an order. From the broken midpoint toward LVN.",
    },
    cob: { kind: "book", levels: [{ priceTicks: 104, bid: 12, ask: 0 }, { priceTicks: 105, bid: 0, ask: 9 }] },
    svp: [{ priceTicks: 104, bid: 6, ask: 2, unsided: 0 }],
    spec: bookmapSpec,
    lastPriceTicks: 107,
    hover: { timeMs: 80_000, priceTicks: 106 },
  };
  return { ...base, ...overrides, frame: overrides.frame ?? frame };
}

