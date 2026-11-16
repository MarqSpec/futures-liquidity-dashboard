import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { formatQty, formatSigned } from "../domain/format.ts";
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
import { drawFootprint } from "./drawFootprint.ts";
import { drawSeriesPane, type SeriesPaneModel } from "./drawSeriesPane.ts";
import { TimePane } from "./TimePane.tsx";
import { TpoPanel } from "./TpoPanel.tsx";

/** Props of the Detail indicator dock. One tab fills the dock; the others are not mounted. */
export interface IndicatorDockProps {
  readonly market: MarketState;
  readonly layout: LayoutSettings;
  readonly indicators: readonly IndicatorSeries[];
  readonly startMs: number;
  readonly endMs: number;
  readonly crosshair: CrosshairStore;
  readonly showSinglePrints: boolean;
  readonly onReading?: (change: (current: LayoutSettings) => LayoutSettings) => void;
}

const tabLabel: Record<IndicatorPaneId, string> = {
  footprint: "Footprint",
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

function warmupText(series: IndicatorSeries | undefined, latest: string): string {
  if (!series) return "not published";
  return series.ready ? latest : `warming up (${series.seen}/${series.warmup})`;
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
 * The Detail chart's lower dock: Footprint, CVD, RSI, MACD, ATR and TPO, one at a time.
 * The time-series tabs share the chart's window. TPO stays the session profile.
 * Collapsed, only the tab strip shows and no pane is mounted; picking a tab expands it (ARCHITECTURE.md D-39).
 * Order Flow does not mount this dock (REQUIREMENTS.md FR-22).
 */
export function IndicatorDock({ market, layout, indicators, startMs, endMs, crosshair, showSinglePrints, onReading }: IndicatorDockProps) {
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
  const paneModel = (model: Omit<SeriesPaneModel, "startMs" | "endMs">) => ({ ...model, startMs, endMs });

  let body: ReactNode = null;
  if (collapsed) {
    // Collapsed: no pane is mounted, so none draws.
  } else if (selected === "footprint") {
    body = (
      <TimePane
        label="Footprint"
        summary={`Footprint of ${market.orderFlow.footprints.length} closed one-minute bars`}
        className="pane-fill"
        crosshair={crosshair}
        draw={(surface) =>
          drawFootprint(surface, {
            startMs,
            endMs,
            bars: market.orderFlow.footprints,
            developing: market.orderFlow.developingFootprint ?? null,
            spec,
            missingRanges: market.profiles.flatMap((profile) => profile.missingRanges),
            approximateRanges: market.profiles.flatMap((profile) => profile.approximateRanges),
          })
        }
      />
    );
  } else if (selected === "cvd") {
    const cvdPoints: [number, number][] = [
      ...market.orderFlow.cvdPoints.map((p): [number, number] => [p[0], p[1]]),
      [now, market.orderFlow.cvd],
    ];
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
              lines: market.status.cvdKnown ? [{ points: cvdPoints, color: colors.bid }] : [],
              guides: [0],
              format: (v) => formatQty(v),
            }),
          )
        }
      />
    );
  } else if (selected === "rsi14") {
    const rsi = indicator("rsi14");
    const rsiPoints = seriesPoints(rsi, 1, 1, now);
    const latest = (rsiPoints.at(-1)?.[1] ?? 0).toFixed(1);
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
    const latest = `${priceFormat(macdLine.at(-1)?.[1] ?? 0)} / ${priceFormat(macdSignal.at(-1)?.[1] ?? 0)}`;
    body = (
      <TimePane
        label="MACD 12/26/9"
        summary={`MACD ${warmupText(macd, priceFormat(macdLine.at(-1)?.[1] ?? 0))}`}
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
    const latest = priceFormat(atrPoints.at(-1)?.[1] ?? 0);
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
