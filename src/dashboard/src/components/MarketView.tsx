import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { SignalKind } from "../api/schemas.ts";
import { clampPriceShift, shiftPriceRange } from "../domain/bookmap.ts";
import { aggregateCandles } from "../domain/candles.ts";
import { formatTicks } from "../domain/format.ts";
import { aggregateHeat } from "../domain/heat.ts";
import {
  isPaneOn,
  isSideSectionCollapsed,
  isSignalOn,
  withDetailChart,
  withSideSectionCollapsed,
  type LayoutSettings,
  type PaneId,
  type SideSectionId,
} from "../domain/layout.ts";
import { indicatorsForViewer, type MarketState } from "../domain/merge.ts";
import { lastPriceAnchor } from "../domain/priceLock.ts";
import { fitRange, zoomRange } from "../domain/scale.ts";
import { clampWindow, LIVE_EDGE_PAD, panOffsetMs, zoomTimeAbout, type ViewWindow } from "../domain/viewWindow.ts";
import type { CrosshairStore } from "../hooks/crosshair.ts";
import { usePriceControls } from "../hooks/usePriceControls.ts";
import { DomLadder } from "./DomLadder.tsx";
import { IndicatorDock } from "./IndicatorDock.tsx";
import { LayersPanel } from "./LayersPanel.tsx";
import { LiquidityPanel } from "./LiquidityPanel.tsx";
import { MainChart } from "./MainChart.tsx";
import { OverlayPanel } from "./OverlayPanel.tsx";
import { PriceControls } from "./PriceControls.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";
import type { SideFold } from "./SidePanel.tsx";
import { SignalsPanel } from "./SignalsPanel.tsx";

/** Props of the market view. */
export interface MarketViewProps {
  readonly market: MarketState;
  readonly layout: LayoutSettings;
  readonly viewWindow: ViewWindow;
  readonly crosshair: CrosshairStore;
  readonly onWindow: (change: (current: ViewWindow) => ViewWindow) => void;
  readonly onResetWindow: () => void;
  readonly onTogglePane: (pane: PaneId, on: boolean) => void;
  readonly onToggleKind: (kind: SignalKind, on: boolean) => void;
  readonly onReading?: (change: (current: LayoutSettings) => LayoutSettings) => void;
}

const emaIds = ["ema10", "ema13", "ema24", "ema48", "ema200"] as const;
const profileWindows = [
  ["5d", "profile-5d"],
  ["session", "profile-session"],
  ["1h", "profile-1h"],
  ["4h", "profile-4h"],
] as const;

/** Every pane for one instrument's state: the chart column and the always-visible side column. */
export function MarketView({ market, layout, viewWindow, crosshair, onWindow, onResetWindow, onTogglePane, onToggleKind, onReading }: MarketViewProps) {
  const [profileWindow, setProfileWindow] = useState<string>("session");
  const windowRef = useRef(viewWindow);
  const historyRef = useRef(market.historyMinutes * 60_000);
  const fittedSpanRef = useRef(1);
  const priceShiftRef = useRef(0);
  const zoomedRef = useRef({ low: 0, high: 1 });
  const anchorRef = useRef<number | null>(null);
  const rootRef = useRef(market.root);
  const [priceShift, setPriceShift] = useState<{ root: string; ticks: number } | null>(null);
  const [trackedRoot, setTrackedRoot] = useState(market.root);
  // A return to an instrument must start fitted. Clearing the ref alone leaves this state, so A→B→A restores the drag.
  const switchingInstrument = trackedRoot !== market.root;
  if (switchingInstrument) {
    setTrackedRoot(market.root);
    setPriceShift(null);
  }
  const shiftTicks = !switchingInstrument && priceShift?.root === market.root ? priceShift.ticks : 0;
  const spec = market.instrument;
  const historyMs = market.historyMinutes * 60_000;
  const view = clampWindow(viewWindow, historyMs);
  // The same lag Order Flow uses, so a shared ViewWindow is the same window on both tabs.
  const endMs = market.serverTimeMs + view.spanMs * LIVE_EDGE_PAD - view.offsetMs;
  const startMs = endMs - view.spanMs;
  const paneOn = (pane: PaneId) => isPaneOn(layout, pane);
  const kindOn = (kind: string) => isSignalOn(layout, kind);
  // Over the server's depth cap, or with depth off, a product streams trades and quotes only: its heat and DOM
  // panes stay empty rather than show a book the server no longer keeps.
  const depth = market.status.depthSubscribed;

  const bucketMs = layout.chartMinutes * 60_000;
  const sourceBars = market.minuteBars.length > 0 || market.developingMinute ? market.minuteBars : market.bars;
  const sourceDeveloping = market.developingMinute ?? (market.minuteBars.length > 0 ? null : market.developingBar);
  const candles = useMemo(
    () => aggregateCandles(sourceBars, sourceDeveloping, market.serverTimeMs, bucketMs),
    [sourceBars, sourceDeveloping, market.serverTimeMs, bucketMs],
  );
  const heatSource = useMemo(() => {
    const minute = market.developingMinuteHeat ? [...market.minuteHeat, market.developingMinuteHeat] : market.minuteHeat;
    return minute.length > 0 ? minute : market.heat;
  }, [market.minuteHeat, market.developingMinuteHeat, market.heat]);
  const heatColumns = useMemo(() => aggregateHeat(heatSource, bucketMs), [heatSource, bucketMs]);
  const profile = market.profiles.find((item) => item.window === "5d") ?? market.profiles.find((item) => item.window === "session") ?? null;
  // The footprint is Detail's main chart unless the layout names the price chart (ARCHITECTURE.md D-55).
  const footprintChart = layout.detailChart === "footprint";
  const flow = market.orderFlow;
  const footprintBars = flow.developingFootprint ? [...flow.footprints, flow.developingFootprint] : flow.footprints;
  // The footprint fits its own bars: the candles reach back past the footprints the server keeps.
  const footprintValues = footprintChart
    ? footprintBars.filter((bar) => bar.t + bar.d >= startMs && bar.t <= endMs).flatMap((bar) => [bar.h, bar.l])
    : [];
  const visibleCandles = candles.filter((c) => c.t + c.d >= startMs && c.t <= endMs);
  const priceValues = footprintValues.some((value) => value != null) ? footprintValues : visibleCandles.flatMap((c) => [c.h, c.l]);
  const dataValues = [...priceValues, market.liquidity.bestBid, market.liquidity.bestAsk];
  const fitted =
    fitRange(dataValues) ??
    fitRange([market.status.coveredLow, market.status.coveredHigh]) ?? { low: 0, high: 100 };
  const fittedSpan = Math.max(1, fitted.high - fitted.low);
  const zoomed = zoomRange(fitted.low, fitted.high, view.priceZoom);
  const range = shiftPriceRange(zoomed, clampPriceShift(shiftTicks, zoomed.high - zoomed.low));
  const anchorTicks = lastPriceAnchor(market.prints, candles);
  useLayoutEffect(() => {
    historyRef.current = historyMs;
    fittedSpanRef.current = fittedSpan;
    zoomedRef.current = zoomed;
    anchorRef.current = anchorTicks;
    if (rootRef.current !== market.root) {
      rootRef.current = market.root;
      priceShiftRef.current = 0;
    }
    windowRef.current = viewWindow;
  });
  const chartSignals = market.orderFlow.signals.filter((s) => kindOn(s.kind));
  const last = candles.at(-1)?.c ?? null;
  const indicators = useMemo(
    () => indicatorsForViewer(market.indicators, layout.indicatorMinutes),
    [market.indicators, layout.indicatorMinutes],
  );
  const chartMarket = useMemo(() => ({ ...market, indicators }), [market, indicators]);

  // Notches read this ref outside the state updater, so a trackpad burst stays on the same instant.
  const commitWindow = (next: ViewWindow) => {
    windowRef.current = next;
    onWindow(() => next);
  };
  const zoomTime = (factor: number, anchorFraction?: number): boolean => {
    const current = windowRef.current;
    // No fraction keeps the live edge (offset unchanged). That is fraction 1 − pad.
    const fraction = anchorFraction ?? 1 - LIVE_EDGE_PAD;
    const next = zoomTimeAbout(current.spanMs, current.offsetMs, fraction, factor, historyRef.current);
    if (next.spanMs === current.spanMs && next.offsetMs === current.offsetMs) return false;
    commitWindow({ ...current, spanMs: next.spanMs, offsetMs: next.offsetMs });
    return true;
  };
  // +, −, Fit, Center and Lock, shared with Order Flow. Every Detail price zoom (the buttons, the keys,
  // Shift+wheel and a pinch) is `zoomBy`: about the midpoint, through the clamp after a drag, and it releases Lock.
  // — midpoint here; the Order Flow wheel uses the pointer (D-38).
  const priceActions = usePriceControls({
    locked: layout.centerPrice,
    onReading,
    scene: () => ({
      zoomed: zoomedRef.current,
      fittedSpan: fittedSpanRef.current,
      priceZoom: windowRef.current.priceZoom,
      shiftTicks: priceShiftRef.current,
      anchorTicks: anchorRef.current,
    }),
    setShift: (ticks) => {
      priceShiftRef.current = ticks;
      setPriceShift(ticks === 0 ? null : { root: rootRef.current, ticks });
    },
    setZoom: (priceZoom) => commitWindow({ ...windowRef.current, priceZoom }),
    resetWindow: onResetWindow,
  });
  const pan = (deltaMs: number) => {
    const current = windowRef.current;
    // The chart already scaled the drag into milliseconds. Passing the span as the width adds that many milliseconds.
    const offsetMs = panOffsetMs(current.offsetMs, deltaMs, current.spanMs, current.spanMs, historyRef.current);
    commitWindow({ ...current, offsetMs });
  };
  const panPrice = (deltaTicks: number) => {
    const span = Math.max(1, fittedSpanRef.current * windowRef.current.priceZoom);
    const ticks = clampPriceShift(priceShiftRef.current + deltaTicks, span);
    priceShiftRef.current = ticks;
    setPriceShift({ root: rootRef.current, ticks });
  };

  const enabledProfiles: string[] = profileWindows.filter(([, id]) => paneOn(id)).map(([w]) => w);
  const selectedProfile = enabledProfiles.includes(profileWindow) ? profileWindow : (enabledProfiles[0] ?? "session");
  const showProfile = enabledProfiles.length > 0;
  // Each side section folds to its heading; the folded set is saved with the layout (ARCHITECTURE.md D-49).
  const fold = (section: SideSectionId): SideFold => ({
    collapsed: isSideSectionCollapsed(layout, section),
    onToggle: () => onReading?.((current) => withSideSectionCollapsed(current, section, !isSideSectionCollapsed(current, section))),
  });
  const lastPriceText = last === null ? "no trades" : `last ${formatTicks(last, spec)}`;
  const chartSummary = footprintChart
    ? `${spec.name} ${market.status.provenance.toLowerCase()} footprint chart, ${lastPriceText}, ${flow.footprints.length} closed one-minute footprint bars`
    : `${spec.name} ${market.status.provenance.toLowerCase()} chart, ${lastPriceText}, ${candles.length} ${layout.chartMinutes}-minute candles`;
  const chooseChart = (chart: "footprint" | "price") => onReading?.((current) => withDetailChart(current, chart));

  return (
    <div className="workspace">
      <div className="chart-column">
        {!depth && (
          <p className="depth-note" role="note">
            Trades and quotes only: no depth for this product right now
          </p>
        )}
        <div className="chart-price-controls" role="toolbar" aria-label="Detail chart controls">
          <fieldset>
            <legend>Main chart</legend>
            <button type="button" aria-pressed={footprintChart} onClick={() => chooseChart("footprint")}>
              Footprint
            </button>
            <button type="button" aria-pressed={!footprintChart} onClick={() => chooseChart("price")}>
              Price
            </button>
          </fieldset>
          <PriceControls locked={layout.centerPrice} canCenter={anchorTicks != null} actions={priceActions} />
        </div>
        <MainChart
          model={{
            market: chartMarket,
            candles,
            startMs,
            endMs,
            lowTicks: range.low,
            highTicks: range.high,
            heatmap: depth && paneOn("heatmap"),
            heatColumns,
            heatMode: layout.heatMode,
            heatContrast: layout.heatContrast,
            heatScale: 1,
            showCandles: layout.showCandles,
            showVolumeDots: layout.showVolumeDots,
            heatDim: layout.heatDim,
            heatLowPercentile: layout.heatLowPercentile,
            heatHighPercentile: layout.heatHighPercentile,
            heatAutoContrast: layout.heatAutoContrast,
            dotMinQuantity: layout.dotMinQuantity,
            hideValueArea: layout.hideValueArea,
            emphasizeNodes: layout.emphasizeNodes,
            levelTouches: market.levelTouches,
            profile,
            emaIds: emaIds.filter((id) => paneOn(id)),
            vwap: paneOn("vwap"),
            overlay: paneOn("overlay"),
            signals: chartSignals,
            isKindOn: kindOn,
            footprint: footprintChart
              ? {
                  bars: flow.footprints,
                  developing: flow.developingFootprint ?? null,
                  missingRanges: market.profiles.flatMap((item) => item.missingRanges),
                  approximateRanges: market.profiles.flatMap((item) => item.approximateRanges),
                }
              : null,
          }}
          spec={spec}
          crosshair={crosshair}
          summary={chartSummary}
          label={footprintChart ? "Footprint" : "Price, liquidity and order flow"}
          onZoomTime={zoomTime}
          onZoomPrice={priceActions.zoomBy}
          onPan={pan}
          onPanPrice={panPrice}
          onReset={priceActions.fit}
          priceLocked={layout.centerPrice}
          onReleaseLock={priceActions.releaseLock}
        />
        <IndicatorDock
          market={market}
          layout={layout}
          candles={candles}
          indicators={indicators}
          startMs={startMs}
          endMs={endMs}
          crosshair={crosshair}
          showSinglePrints={kindOn("SinglePrints")}
          onReading={onReading}
        />
      </div>
      <aside className="side-column" aria-label="Depth, liquidity and signals">
        {paneOn("ladder") && <DomLadder market={market} isKindOn={kindOn} fold={fold("ladder")} />}
        <LiquidityPanel liquidity={market.liquidity} spec={spec} fold={fold("liquidity")} />
        <SignalsPanel signals={market.orderFlow.signals} spec={spec} isKindOn={kindOn} onToggleKind={onToggleKind} fold={fold("signals")} />
        <OverlayPanel overlay={market.overlay} spec={spec} shown={paneOn("overlay")} fold={fold("levels")} />
        {showProfile && (
          <ProfilePanel
            profiles={market.profiles}
            windows={enabledProfiles}
            selected={selectedProfile}
            onSelect={setProfileWindow}
            spec={spec}
            lastTicks={last}
            fold={fold("profile")}
          />
        )}
        <LayersPanel
          isPaneOn={paneOn}
          onToggle={onTogglePane}
          indicators={indicators}
          layout={layout}
          onReading={onReading ?? (() => undefined)}
          fold={fold("layers")}
        />
      </aside>
    </div>
  );
}
