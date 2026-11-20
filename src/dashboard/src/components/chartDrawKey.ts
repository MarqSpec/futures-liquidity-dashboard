import type { HeatColumn } from "../api/schemas.ts";
import type { Candle } from "../domain/candles.ts";
import { firstColumnEndingAfter } from "../domain/heat.ts";
import { signalKindNames } from "../domain/signals.ts";
import { canvasFonts } from "../lib/canvasFonts.ts";
import { fnvHex, fnvStart, mix, mixNumbers } from "../lib/fnv.ts";
import { canvasTheme } from "../theme.ts";
import { stampFootprintBar } from "./drawFootprint.ts";
import type { MainChartModel } from "./drawMainChart.ts";

/** Cell hashes for columns the chart does not mutate. A corrected column is a new object, so this cannot go stale. */
const heatStamp = new WeakMap<HeatColumn, number>();

/**
 * Identity of what `drawMainChart` would put on the canvas. Time is quantised to one pixel, so a live edge that
 * has not moved a pixel does not redraw. Values are mixed with FNV-1a, not added, so two different inputs cannot
 * cancel to the same total. `fontEpoch` changes once the canvas fonts load, so text drawn in the fallback face is redrawn;
 * `palette` is the canvas palette, so a theme switch or a changed chart colour redraws the frame in the new colours.
 */
export function mainChartDrawKey(
  model: MainChartModel,
  width: number,
  height: number,
  devicePixelRatio = 1,
  fontEpoch = canvasFonts.epoch(),
  palette: string = canvasTheme.palette(),
): string {
  const span = Math.max(1, model.endMs - model.startMs);
  const quantum = span / Math.max(1, width);
  const flow = model.market.orderFlow;
  let hash = fnvStart();
  hash = mix(hash, [
    width,
    height,
    devicePixelRatio,
    fontEpoch,
    palette,
    Math.round(model.startMs / quantum),
    Math.round(model.endMs / quantum),
    Math.floor(model.market.serverTimeMs / 1000),
    model.lowTicks,
    model.highTicks,
    model.heatmap ? 1 : 0,
    model.heatMode,
    model.heatContrast,
    model.heatScale,
    model.showCandles ? 1 : 0,
    model.showVolumeDots === false ? 0 : 1,
    model.heatDim ?? 0,
    model.heatLowPercentile ?? 5,
    model.heatHighPercentile ?? 95,
    model.heatAutoContrast === false ? 0 : 1,
    model.dotMinQuantity ?? 1,
    model.hideValueArea ? 1 : 0,
    model.emphasizeNodes ? 1 : 0,
    model.market.liquidity.quoteStale ? 1 : 0,
    model.vwap ? 1 : 0,
    model.overlay ? 1 : 0,
    model.emaIds.join(","),
    enabledKinds(model.isKindOn),
    model.market.instrument.tickSize,
    model.market.instrument.priceDecimals,
    model.market.status.code,
    model.market.status.provenance,
    model.market.liquidity.bestBid ?? "",
    model.market.liquidity.bestAsk ?? "",
    model.market.historyWatermarkMs ?? "",
    model.market.vwap.vwap ?? "",
    model.market.vwap.stdDev ?? "",
    model.market.vwap.partial ? 1 : 0,
    model.market.vwap.anchor ?? "",
  ]);
  hash = mixCandles(hash, model.candles);
  hash = mixList(hash, model.market.prints.map((print) => [print.sequence, print.sourceTimeMs, print.priceTicks, print.quantity, print.aggressor]));
  hash = mixHeat(hash, model);
  hash = mixList(hash, model.signals.map((signal) => [signal.id, signal.kind, signal.bias, signal.timeMs, signal.priceTicks, signal.priceHighTicks, signal.strength, signal.label, signal.detail]));
  hash = mixList(hash, model.levelTouches.map((level) => [level.name, level.priceTicks, level.isHigh ? 1 : 0, level.touches, level.isThirdTouch ? 1 : 0, level.lastTouchMs ?? "", level.held, level.broke]));
  hash = mixList(hash, flow.keyLevels.map((level) => [level.name, level.priceTicks, level.isHigh ? 1 : 0]));
  hash = mix(hash, [flow.footprintSeconds]);
  hash = mixList(hash, flow.zones.map((zone) => [zone.bias, zone.lowTicks, zone.highTicks, zone.levels, zone.averageRatio]));
  hash = mixList(hash, flow.unfinishedAuctions.map((auction) => [auction.priceTicks, auction.atHigh ? 1 : 0, auction.barStartMs, auction.bidVolume, auction.askVolume]));
  hash = mixList(hash, flow.icebergs.map((ice) => [ice.side, ice.priceTicks, ice.traded, ice.displayed, ice.peakDisplayed, ice.refills, ice.averageRefill, ice.hiddenEstimate, ice.confidence, ice.firstSeenMs, ice.lastFillMs, ice.active ? 1 : 0]));
  hash = mixProfile(hash, model.profile);
  hash = mixIndicators(hash, model);
  hash = mixTrail(hash, model);
  hash = mixOverlay(hash, model);
  hash = mixFootprint(hash, model);
  hash = mixList(hash, (model.rangeZones ?? []).map((zone) => [zone.startMs, zone.endMs, zone.lowTicks, zone.highTicks]));
  return fnvHex(hash);
}

/** The footprint bars in the window, the forming one included, when Detail's main chart is the footprint. */
function mixFootprint(hash: number, model: MainChartModel): number {
  const layer = model.footprint;
  if (!layer) return mix(hash, ["no-footprint"]);
  const bars = layer.developing ? [...layer.bars, layer.developing] : layer.bars;
  let drawn = 0;
  for (const bar of bars) {
    if (bar.t + bar.d < model.startMs || bar.t > model.endMs) continue;
    drawn += 1;
    // The forming bar is a new object on each delta, so its stamp is never reused once it has changed.
    hash = mix(hash, [stampFootprintBar(bar)]);
  }
  hash = mix(hash, [drawn]);
  hash = mixList(hash, layer.missingRanges.map((range) => [range[0], range[1] ?? ""]));
  return mixList(hash, layer.approximateRanges.map((range) => [range[0], range[1] ?? ""]));
}

/** The kinds the chart asks `isKindOn` about, in a stable order. */
function enabledKinds(isKindOn: (kind: string) => boolean): string {
  return Object.keys(signalKindNames)
    .filter((kind) => isKindOn(kind))
    .join(",");
}

function mixList(hash: number, rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): number {
  hash = mix(hash, [rows.length]);
  for (const row of rows) hash = mix(hash, row);
  return hash;
}

function mixCandles(hash: number, candles: readonly Candle[]): number {
  hash = mix(hash, [candles.length]);
  for (const candle of candles) {
    hash = mix(hash, [candle.t, candle.d, candle.o, candle.h, candle.l, candle.c, candle.v, candle.bv, candle.sv, candle.developing ? 1 : 0]);
  }
  return hash;
}

function mixHeat(hash: number, model: MainChartModel): number {
  // Every cell that can change a pixel is stamped, including the column just before the window in flow mode
  // (its totals are the first visible delta). A closed column can be corrected without changing its time or length.
  if (!model.heatmap) return mix(hash, ["heat-off"]);
  const columns = model.heatColumns;
  const first = firstColumnEndingAfter(columns, model.startMs);
  const start = model.heatMode === "flow" ? Math.max(0, first - 1) : first;
  let stamped = 0;
  for (let index = start; index < columns.length; index++) {
    const column = columns[index];
    if (!column || column.t > model.endMs) break;
    hash = mix(hash, [stampHeatColumn(column)]);
    stamped += 1;
  }
  return mix(hash, [stamped]);
}

function stampHeatColumn(column: HeatColumn): number {
  const cached = heatStamp.get(column);
  if (cached !== undefined) return cached;
  const hash = mix(mixNumbers(fnvStart(), column.c), [column.t, column.d]);
  heatStamp.set(column, hash);
  return hash;
}

/** The VWAP mid line and its bands. Points before the window are not drawn. */
function mixTrail(hash: number, model: MainChartModel): number {
  if (!model.vwap) return mix(hash, ["no-trail"]);
  let count = 0;
  for (const point of model.market.vwapTrail) {
    if (point[0] < model.startMs) continue;
    count += 1;
    hash = mixNumbers(hash, point);
  }
  return mix(hash, [count]);
}

function mixProfile(hash: number, profile: MainChartModel["profile"]): number {
  if (!profile) return mix(hash, ["none"]);
  hash = mix(hash, [profile.window, profile.total, profile.poc ?? "", profile.vah ?? "", profile.val ?? "", profile.vaFraction ?? "", profile.partialSinceMs ?? ""]);
  hash = mixList(hash, profile.missingRanges.map((range) => [range[0], range[1] ?? ""]));
  hash = mixList(hash, profile.approximateRanges.map((range) => [range[0], range[1] ?? ""]));
  hash = mixList(hash, profile.bins.map((bin) => [bin[0], bin[1]]));
  hash = mix(hash, profile.hvn);
  hash = mix(hash, profile.lvn);
  return hash;
}

function mixIndicators(hash: number, model: MainChartModel): number {
  for (const id of model.emaIds) {
    const series = model.market.indicators.find((item) => item.id === id);
    hash = mix(hash, [id, series ? 1 : 0]);
    if (!series) continue;
    // Same window as drawEmas. tf seconds is the culling margin. A snapshot can rewrite a drawn point
    // without changing the length or the last point, and that still has to miss the cached frame.
    const margin = series.tf * 1000;
    const from = model.startMs - margin;
    const to = model.endMs + margin;
    let drawn = 0;
    hash = mix(hash, [series.ready ? 1 : 0, series.tf, series.seen, series.dev?.[0] ?? ""]);
    for (const point of series.points) {
      const t = point[0];
      const value = point[1];
      if (t === null || t === undefined || value === null || value === undefined || t < from) continue;
      if (t > to) break;
      drawn += 1;
      hash = mix(hash, point);
    }
    hash = mix(hash, [drawn]);
  }
  return hash;
}

function mixOverlay(hash: number, model: MainChartModel): number {
  const overlay = model.market.overlay;
  if (!model.overlay || !overlay) return mix(hash, ["none"]);
  hash = mix(hash, [overlay.version, overlay.expired ? 1 : 0, overlay.publisher, overlay.expiresAtMs]);
  hash = mixList(
    hash,
    overlay.levels.map((level) => [level.priceTicks, level.price, level.label, level.kind]),
  );
  return hash;
}
