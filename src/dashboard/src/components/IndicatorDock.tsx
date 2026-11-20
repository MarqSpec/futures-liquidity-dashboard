import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import type { Candle } from "../domain/candles.ts";
import { formatQty, formatSigned } from "../domain/format.ts";
import { fitRange } from "../domain/scale.ts";
import {
  indicatorPanes,
  withIndicatorDockCollapsed,
  withIndicatorPane,
  type IndicatorPaneId,
  type LayoutSettings,
} from "../domain/layout.ts";
import type { IndicatorSeries, MarketState } from "../domain/merge.ts";
import type { CrosshairStore } from "../hooks/crosshair.ts";
import { colors, indicatorColors } from "../theme.ts";
import { drawSeriesPane, type SeriesLine, type SeriesPaneModel } from "./drawSeriesPane.ts";
import { drawVolumePane, volumePaneBars } from "./drawVolumePane.ts";
import { TimePane } from "./TimePane.tsx";
import { TpoPanel } from "./TpoPanel.tsx";

/** Props of the indicator dock, on Detail and Order Flow. One tab fills the dock; the others are not mounted. */
export interface IndicatorDockProps {
  readonly market: MarketState;
  readonly layout: LayoutSettings;
  /** The main chart's bars, at its interval: the Volume tab draws one bar each. */
  readonly candles: readonly Candle[];
  readonly indicators: readonly IndicatorSeries[];
  readonly startMs: number;
  readonly endMs: number;
  readonly crosshair: CrosshairStore;
  readonly showSinglePrints: boolean;
  readonly onReading?: (change: (current: LayoutSettings) => LayoutSettings) => void;
  /**
   * The width the time-series tabs leave at the right for their value axis, `AXIS_WIDTH` when unset. Order Flow
   * passes its PRICE, COB and SVP columns' width, so each tab's time axis spans the plot above it.
   */
  readonly axisWidth?: number;
}

const tabLabel: Record<IndicatorPaneId, string> = {
  volume: "Volume",
  cvd: "CVD",
  rsi14: "RSI",
  macd: "MACD",
  atr14: "ATR",
  tpo: "TPO",
};

function seriesPoints(series: IndicatorSeries | undefined, index: number, scale: number, nowMs: number): [number, number][] {
  if (!series) return [];
  const points: [number, number][] = [];
  for (const p of series.points) {
    const t = p[0];
    const v = p[index];
    if (t != null && v != null) points.push([t, v * scale]);
  }
  const dev = series.dev?.[index - 1];
  if (dev != null) points.push([nowMs, dev * scale]);
  return points;
}

// — the maintainer's colour ruling.
/**
 * The session CVD as two stretches, as Order Flow's CVD subchart drew it: up to the watermark in the warmup colour,
 * after it in `up` while the session CVD is positive, `down` while it is negative and the text colour at zero, with no
 * segment between them (REQUIREMENTS.md FR-61, ARCHITECTURE.md D-48). The live value now ends the live stretch.
 */
function cvdLines(points: readonly (readonly [number, number])[], cvd: number, nowMs: number, watermarkMs: number | null): SeriesLine[] {
  const warmup: [number, number][] = [];
  const live: [number, number][] = [];
  for (const [t, v] of [...points, [nowMs, cvd] as const]) {
    (watermarkMs !== null && t <= watermarkMs ? warmup : live).push([t, v]);
  }
  return [
    { points: warmup, color: colors.warmup },
    { points: live, color: cvd > 0 ? colors.up : cvd < 0 ? colors.down : colors.text },
  ];
}

/**
 * The CVD tab's value range: fitted to the line in the window, as Order Flow's CVD subchart fitted it, so a session CVD
 * far from zero keeps its shape. The zero guide is drawn only when zero is in that range. With no point in view, the
 * pane fits itself around the zero guide.
 */
function cvdScale(lines: readonly SeriesLine[], startMs: number, endMs: number): Pick<SeriesPaneModel, "range" | "guides"> {
  const inView = lines.flatMap((line) => line.points.filter(([t]) => t >= startMs && t <= endMs).map(([, v]) => v));
  const range = fitRange(inView, 0.08, 2);
  if (range === null) return { guides: [0] };
  return { range, guides: range.low <= 0 && range.high >= 0 ? [0] : [] };
}

function warmupText(series: IndicatorSeries | undefined, latest: string): string {
  if (!series) return "not published";
  return series.ready ? latest : `warming up (${series.seen}/${series.warmup})`;
}

/** A pane header's readout: each value after its name, e.g. "Line 1.25 · Signal 1.10" (REQUIREMENTS.md FR-20). */
function named(values: readonly (readonly [name: string, value: string])[]): string {
  return values.map(([name, value]) => `${name} ${value}`).join(" · ");
}

function step(selected: IndicatorPaneId, key: string): IndicatorPaneId | null {
  const index = indicatorPanes.indexOf(selected);
  if (key === "ArrowRight" || key === "ArrowDown") return indicatorPanes[(index + 1) % indicatorPanes.length] ?? selected;
  if (key === "ArrowLeft" || key === "ArrowUp") return indicatorPanes[(index - 1 + indicatorPanes.length) % indicatorPanes.length] ?? selected;
  if (key === "Home") return indicatorPanes[0] ?? selected;
  if (key === "End") return indicatorPanes[indicatorPanes.length - 1] ?? selected;
  return null;
}

/**
 * The dock under the Detail and Order Flow charts: Volume, CVD, RSI, MACD, ATR and TPO, one at a time. Both tabs show
 * the tab the layout names and collapse it together (REQUIREMENTS.md FR-22, ARCHITECTURE.md D-55).
 * The time-series tabs share the chart's window. TPO stays the session profile.
 * Collapsed, only the tab strip shows and no pane is mounted; picking a tab expands it (ARCHITECTURE.md D-39).
 */
export function IndicatorDock({ market, layout, candles, indicators, startMs, endMs, crosshair, showSinglePrints, onReading, axisWidth }: IndicatorDockProps) {
  const uid = useId();
  const selected = layout.indicatorPane;
  const collapsed = layout.indicatorDockCollapsed;
  const pendingFocus = useRef<IndicatorPaneId | null>(null);
  const tabId = (pane: IndicatorPaneId) => `${uid}-tab-${pane}`;
  const panelId = `${uid}-panel`;
  const spec = market.instrument;
  const now = market.serverTimeMs;

  useLayoutEffect(() => {
    const pane = pendingFocus.current;
    if (pane === null || pane !== selected) return;
    pendingFocus.current = null;
    document.getElementById(`${uid}-tab-${pane}`)?.focus();
  }, [selected, uid]);

  const choose = (pane: IndicatorPaneId, moveFocus: boolean) => {
    if (moveFocus) pendingFocus.current = pane;
    onReading?.((current) => withIndicatorDockCollapsed(withIndicatorPane(current, pane), false));
  };

  const toggleCollapsed = () => {
    onReading?.((current) => withIndicatorDockCollapsed(current, !current.indicatorDockCollapsed));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const pane = step(selected, event.key);
    if (pane === null) return;
    event.preventDefault();
    choose(pane, true);
  };

  const indicator = (id: string) => indicators.find((series) => series.id === id);
  const priceFormat = (v: number) => v.toFixed(spec.priceDecimals);
  const paneModel = (model: Omit<SeriesPaneModel, "startMs" | "endMs">) => ({ ...model, startMs, endMs, axisWidth });

  let body: ReactNode = null;
  if (collapsed) {
    // Collapsed: no pane is mounted, so none draws.
  } else if (selected === "volume") {
    const bars = volumePaneBars(candles, market.historyWatermarkMs);
    body = (
      <TimePane
        label="Volume"
        summary={`Traded volume of ${bars.length} bars, warmup bars without an aggressor side`}
        className="pane-fill"
        crosshair={crosshair}
        draw={(surface) => drawVolumePane(surface, { startMs, endMs, bars, axisWidth })}
      />
    );
  } else if (selected === "cvd") {
    const lines = market.status.cvdKnown ? cvdLines(market.orderFlow.cvdPoints, market.orderFlow.cvd, now, market.historyWatermarkMs) : [];
    body = (
      <TimePane
        label="Cumulative volume delta"
        summary={market.status.cvdKnown ? `Session CVD ${formatSigned(market.orderFlow.cvd)}` : "CVD unknown"}
        className="pane-fill"
        crosshair={crosshair}
        draw={(surface) =>
          drawSeriesPane(
            surface,
            paneModel({
              title: "CVD (session)",
              subtitle: market.status.cvdKnown ? formatSigned(market.orderFlow.cvd) : "unknown",
              dimmed: !market.status.cvdKnown,
              lines,
              ...cvdScale(lines, startMs, endMs),
              format: (v) => formatQty(v),
            }),
          )
        }
      />
    );
  } else if (selected === "rsi14") {
    const rsi = indicator("rsi14");
    const rsiPoints = seriesPoints(rsi, 1, 1, now);
    const latest = named([["Value", (rsiPoints.at(-1)?.[1] ?? 0).toFixed(1)]]);
    body = (
      <TimePane
        label="RSI 14"
        summary={`RSI 14 ${warmupText(rsi, latest)}`}
        className="pane-fill"
        crosshair={crosshair}
        draw={(surface) =>
          drawSeriesPane(
            surface,
            paneModel({
              title: "RSI 14",
              subtitle: warmupText(rsi, latest),
              dimmed: !rsi?.ready,
              lines: [{ points: rsiPoints, color: indicatorColors.rsi }],
              range: { low: 0, high: 100 },
              guides: [30, 70],
              format: (v) => v.toFixed(0),
            }),
          )
        }
      />
    );
  } else if (selected === "macd") {
    const macd = indicator("macd");
    const macdLine = seriesPoints(macd, 1, spec.tickSize, now);
    const macdSignal = seriesPoints(macd, 2, spec.tickSize, now);
    const macdHist = seriesPoints(macd, 3, spec.tickSize, now);
    const values = (histogram: string) =>
      named([
        ["Line", priceFormat(macdLine.at(-1)?.[1] ?? 0)],
        ["Signal", priceFormat(macdSignal.at(-1)?.[1] ?? 0)],
        [histogram, priceFormat(macdHist.at(-1)?.[1] ?? 0)],
      ]);
    // Short on the chip so it fits a phone; the hidden summary always fits, so it spells the word out.
    const latest = values("Hist");
    body = (
      <TimePane
        label="MACD 12/26/9"
        summary={`MACD 12/26/9 ${warmupText(macd, values("Histogram"))}`}
        className="pane-fill"
        crosshair={crosshair}
        draw={(surface) =>
          drawSeriesPane(
            surface,
            paneModel({
              title: "MACD 12/26/9",
              subtitle: warmupText(macd, latest),
              dimmed: !macd?.ready,
              lines: [
                { points: macdLine, color: indicatorColors.macd },
                { points: macdSignal, color: indicatorColors.macdSignal },
              ],
              histogram: { points: macdHist, barMs: (macd?.tf ?? 60) * 1000 },
              guides: [0],
              format: priceFormat,
            }),
          )
        }
      />
    );
  } else if (selected === "atr14") {
    const atr = indicator("atr14");
    const atrPoints = seriesPoints(atr, 1, spec.tickSize, now);
    const latest = named([["Value", priceFormat(atrPoints.at(-1)?.[1] ?? 0)]]);
    body = (
      <TimePane
        label="ATR 14"
        summary={`ATR 14 ${warmupText(atr, latest)}`}
        className="pane-fill"
        crosshair={crosshair}
        draw={(surface) =>
          drawSeriesPane(
            surface,
            paneModel({
              title: "ATR 14",
              subtitle: warmupText(atr, latest),
              dimmed: !atr?.ready,
              lines: [{ points: atrPoints, color: indicatorColors.atr }],
              format: priceFormat,
            }),
          )
        }
      />
    );
  } else if (selected === "tpo") {
    body = <TpoPanel tpo={market.orderFlow.tpo} spec={spec} showSinglePrints={showSinglePrints} />;
  } else {
    const unexpected: never = selected;
    body = unexpected;
  }

  return (
    <div className={collapsed ? "indicator-dock collapsed" : "indicator-dock"}>
      <div className="indicator-strip">
        <div
          className="indicator-tabs"
          role="tablist"
          aria-label="Indicator panes"
          aria-orientation="horizontal"
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {indicatorPanes.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={tabId(id)}
              aria-selected={selected === id}
              aria-controls={panelId}
              tabIndex={selected === id ? 0 : -1}
              onClick={() => choose(id, false)}
            >
              {tabLabel[id]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Indicator dock"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          title={collapsed ? "Expand the indicator dock" : "Collapse the indicator dock to its tabs"}
          onClick={toggleCollapsed}
        >
          <span aria-hidden="true">{collapsed ? "▴" : "▾"}</span>
        </button>
      </div>
      <div
        className="indicator-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(selected)}
        tabIndex={collapsed ? -1 : 0}
        hidden={collapsed}
      >
        {body}
      </div>
    </div>
  );
}
