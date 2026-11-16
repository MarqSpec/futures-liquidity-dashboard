import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import type { MarketState } from "../domain/merge.ts";
import { aggregateCandles } from "../domain/candles.ts";
import { chartZoomIn, chartZoomOut } from "../domain/chartCursor.ts";
import { formatLocalTime, formatQty, formatTicks } from "../domain/format.ts";
import { aggregateHeat } from "../domain/heat.ts";
import { isSignalOn, withRipsPreset, type LayoutSettings } from "../domain/layout.ts";
import { fitRange, zoomRange } from "../domain/scale.ts";
import { hints } from "../domain/hints.ts";
import { eventMarker, eventMarkers, eventsInWindow } from "../domain/signals.ts";
import { clampWindow, LIVE_EDGE_PAD, panOffsetMs, type ViewWindow, zoomTimeAbout } from "../domain/viewWindow.ts";
import {
  type BookmapFrame,
  type ChartEvent,
  FAILED_RECLAIM_NOTE,
  CENTER_FOLLOW_MS,
  LOCK_RELEASE_DRAG_PX,
  PINCH_PRICE_DEADBAND_PX,
  bookmapFrame,
  bookmapLevels,
  bookmapScales,
  centerPriceShift,
  clampPriceShift,
  cobColumn,
  dotSizePresets,
  dragShiftTicks,
  eventDotRadius,
  eventDotSizeSteps,
  eventHitRadius,
  eventTooltipLines,
  eventUnderPointer,
  failedReclaims,
  guideReclaim,
  heatDimPresets,
  hoverReadout,
  lastPriceSteps,
  liveCvdSummary,
  pinchAxisFactor,
  pointerOnPriceLine,
  priceAt,
  priceAxisZoomFactor,
  priceWheelDelta,
  readOnlyTrailGuide,
  sessionVolumeSplit,
  shiftPriceRange,
  sliceBucketMs,
  sliceVolumeDots,
  stepCenterShift,
  tooltipBox,
  volumeStripBars,
  zoomPriceAbout,
} from "../domain/bookmap.ts";
import { useCanvasFontEpoch } from "../hooks/useCanvasFontEpoch.ts";
import { useCanvasTheme } from "../hooks/useCanvasTheme.ts";
import { useElementSize } from "../hooks/useElementSize.ts";
import { prepareSurface } from "../lib/canvas.ts";
import { drawBookmap, drawBookmapHover, type BookmapHeatScale } from "./drawBookmap.ts";
import { Hint } from "./Hint.tsx";

/** Props of the Bookmap tab. It reads the live market and the saved layout, and it places no order. */
export interface BookmapViewProps {
  readonly market: MarketState;
  readonly layout: LayoutSettings;
  readonly viewWindow: ViewWindow;
  readonly onReading: (change: (current: LayoutSettings) => LayoutSettings) => void;
  /** Changes the shared view window. Shift+wheel writes `priceZoom` here, the same zoom Detail uses. */
  readonly onWindow: (change: (current: ViewWindow) => ViewWindow) => void;
}

/** A plot pan: the pointer, where it went down, and the price shift and time offset when it did. */
interface PanDrag {
  readonly kind: "pan";
  readonly pointer: number;
  readonly x: number;
  readonly y: number;
  readonly ticks: number;
  readonly offsetMs: number;
  readonly spanMs: number;
}

/** A PRICE-axis zoom: the zoom and shift when it started, and the price fraction that should stay put. */
interface AxisZoom {
  readonly kind: "zoom";
  readonly pointer: number;
  readonly y: number;
  readonly zoom: number;
  readonly shift: number;
  readonly fraction: number;
  readonly fittedSpan: number;
}

interface Pinch {
  readonly dx: number;
  readonly dy: number;
  readonly zoom: number;
  readonly shift: number;
  readonly fractionY: number;
  readonly fittedSpan: number;
  readonly spanMs: number;
  readonly offsetMs: number;
  readonly fractionX: number;
}

const ZOOM_HINT_KEY = "futures-liquidity-dashboard.bookmap-zoom-hint";

function zoomHintOpen(): boolean {
  try {
    return sessionStorage.getItem(ZOOM_HINT_KEY) !== "dismissed";
  } catch {
    return true;
  }
}

function localPoint(stage: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = stage.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function hitZone(frame: BookmapFrame, x: number, y: number): "plot" | "price" | "time" | "other" {
  const { plot, price, volume } = frame;
  if (volume && x >= volume.x && x <= volume.x + volume.w && y >= volume.y && y <= volume.y + volume.h) return "time";
  if (x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h) return "plot";
  if (x >= price.x && x <= price.x + price.w && y >= price.y && y <= price.y + price.h) return "price";
  return "other";
}

/**
 * Trader Jon's volume-dot and RIPS layout: heatmap, dots, a docked book and profile, the volume strip and CVD.
 * Detail and Overview do not mount this view (REQUIREMENTS.md FR-67). Nothing here calls a broker (REQUIREMENTS.md FR-6).
 */
export function BookmapView({ market, layout, viewWindow, onReading, onWindow }: BookmapViewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const { width, height } = useElementSize(stageRef);
  const [showBbo, setShowBbo] = useState(true);
  const [showPnc, setShowPnc] = useState(true);
  const [showVolume, setShowVolume] = useState(true);
  const [showCvd, setShowCvd] = useState(true);
  const [hover, setHover] = useState<{ readonly timeMs: number; readonly priceTicks: number } | null>(null);
  // The vertical pan is per visit. Changing instrument, including a return to one already dragged, starts fitted again.
  const [shiftTicks, setShiftTicks] = useState(0);
  const [shiftRoot, setShiftRoot] = useState(market.root);
  const dragRef = useRef<PanDrag | AxisZoom | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<Pinch | null>(null);
  const sceneRef = useRef<{
    frame: BookmapFrame;
    fittedSpan: number;
    range: { low: number; high: number };
    zoomed: { low: number; high: number };
    startMs: number;
    endMs: number;
    summary: { lastPriceTicks: number | null };
    anchorTicks: number | null;
  } | null>(null);
  const shiftRef = useRef(0);
  const lockHeld = useRef(layout.centerPrice);
  const lockProp = useRef(layout.centerPrice);
  const onReadingRef = useRef(onReading);
  const releaseLockRef = useRef(() => {});
  const priceZoomRef = useRef(viewWindow.priceZoom);
  const spanRef = useRef(viewWindow.spanMs);
  const offsetRef = useRef(viewWindow.offsetMs);
  const historyRef = useRef(market.historyMinutes * 60_000);
  const [dragging, setDragging] = useState(false);
  const [showHint, setShowHint] = useState(zoomHintOpen);
  const [showKey, setShowKey] = useState(true);
  const [displayOpen, setDisplayOpen] = useState(false);
  const displayRef = useRef<HTMLDivElement>(null);
  const [heatScale, setHeatScale] = useState<BookmapHeatScale | null>(null);
  // The draw effects list the epoch and the theme, so the canvases paint again once IBM Plex has loaded and once
  // when the theme changes.
  const fontEpoch = useCanvasFontEpoch();
  const theme = useCanvasTheme();
  const [tip, setTip] = useState<{ readonly left: number; readonly top: number; readonly lines: readonly string[] } | null>(null);
  if (shiftRoot !== market.root) {
    setShiftRoot(market.root);
    setShiftTicks(0);
    if (dragging) setDragging(false);
  }
  useLayoutEffect(() => {
    dragRef.current = null;
    pinchRef.current = null;
  }, [market.root]);
  const sessionProfile = market.profiles.find((item) => item.window === "session") ?? null;
  const footprints = useMemo(
    () =>
      market.orderFlow.developingFootprint
        ? [...market.orderFlow.footprints, market.orderFlow.developingFootprint]
        : market.orderFlow.footprints,
    [market.orderFlow.footprints, market.orderFlow.developingFootprint],
  );
  const svp = useMemo(
    () =>
      sessionVolumeSplit(footprints, sessionProfile?.bins ?? [], {
        historyWatermarkMs: market.historyWatermarkMs,
        sessionOpenMs: market.orderFlow.tpo.sessionOpenMs ?? null,
      }),
    [footprints, sessionProfile, market.historyWatermarkMs, market.orderFlow.tpo.sessionOpenMs],
  );
  const reclaims = useMemo(
    () =>
      failedReclaims({
        levels: market.orderFlow.keyLevels,
        prints: market.prints,
        historyWatermarkMs: market.historyWatermarkMs,
      }),
    [market.orderFlow.keyLevels, market.prints, market.historyWatermarkMs],
  );

  // Candles and heat do not depend on the visible window. A time drag must not rebuild them (REQUIREMENTS.md NFR-2).
  const baseReading = useMemo(() => {
    const bucketMs = layout.chartMinutes * 60_000;
    const sourceBars = market.minuteBars.length > 0 || market.developingMinute ? market.minuteBars : market.bars;
    const sourceDeveloping = market.developingMinute ?? (market.minuteBars.length > 0 ? null : market.developingBar);
    const candles = aggregateCandles(sourceBars, sourceDeveloping, market.serverTimeMs, bucketMs);
    const minuteHeat = market.developingMinuteHeat ? [...market.minuteHeat, market.developingMinuteHeat] : market.minuteHeat;
    const heatColumns = aggregateHeat(minuteHeat.length > 0 ? minuteHeat : market.heat, bucketMs);
    const frame = bookmapFrame(Math.max(width, 1), Math.max(height, 1), { volume: showVolume, cvd: showCvd });
    const levels = bookmapLevels({
      preset: layout.preset,
      hideValueArea: layout.hideValueArea,
      keyLevels: market.orderFlow.keyLevels,
      profile: sessionProfile,
      vwapTicks: market.vwap.vwap ?? null,
    });
    const ladderPrices = [...market.ladder.bids, ...market.ladder.asks].map((row) => row[0]);
    const fitted =
      fitRange([
        ...candles.flatMap((candle) => [candle.h, candle.l]),
        ...ladderPrices,
        ...levels.map((level) => level.priceTicks),
        market.liquidity.bestBid,
        market.liquidity.bestAsk,
      ]) ?? { low: 0, high: 100 };
    const bookKnown = market.liquidity.bookKnown && market.status.bookKnown;
    const lastPrint = market.prints.at(-1) ?? null;
    return {
      candles,
      heatColumns,
      frame,
      levels,
      fitted,
      cob: cobColumn({
        bookKnown,
        depthSubscribed: market.status.depthSubscribed,
        bids: market.ladder.bids,
        asks: market.ladder.asks,
      }),
      strip: volumeStripBars(candles, market.historyWatermarkMs),
      summary: liveCvdSummary({
        cvd: market.orderFlow.cvd,
        cvdKnown: market.status.cvdKnown,
        historyWatermarkMs: market.historyWatermarkMs,
        lastPrint,
      }),
      anchorTicks: lastPrint?.priceTicks ?? candles.at(-1)?.c ?? null,
      bboStale:
        market.liquidity.quoteStale ||
        market.status.code === "STALE" ||
        market.liquidity.bestBid == null ||
        market.liquidity.bestAsk == null,
      bookKnown,
    };
  }, [market, layout.chartMinutes, layout.preset, layout.hideValueArea, width, height, showVolume, showCvd, sessionProfile]);

  const sceneBase = useMemo(() => {
    const historyMs = market.historyMinutes * 60_000;
    const view = clampWindow(viewWindow, historyMs);
    const endMs = market.serverTimeMs + view.spanMs * LIVE_EDGE_PAD - view.offsetMs;
    const startMs = endMs - view.spanMs;
    const { frame, fitted } = baseReading;
    const fittedSpan = Math.max(0, fitted.high - fitted.low);
    const zoomed = zoomRange(fitted.low, fitted.high, view.priceZoom);
    const dots = sliceVolumeDots({
      prints: market.prints,
      historyWatermarkMs: market.historyWatermarkMs,
      startMs,
      endMs,
      plotWidthPx: frame.plot.w,
      priceSpanTicks: Math.max(1, zoomed.high - zoomed.low),
      plotHeightPx: frame.plot.h,
      minQuantity: layout.dotMinQuantity,
    });
    const guide = readOnlyTrailGuide({
      reclaim: guideReclaim(reclaims, startMs, endMs),
      poc: sessionProfile?.poc ?? null,
      lvn: sessionProfile?.lvn ?? [],
      levels: market.orderFlow.keyLevels,
    });
    // reference: REQUIREMENTS.md FR-69 — every loaded event in the window, not the newest 40
    const signals = eventsInWindow(market.orderFlow.signals, (kind) => isSignalOn(layout, kind), startMs, endMs).map((signal) => {
        const marker = eventMarker(signal.kind);
        const ice = signal.kind === "Iceberg" ? market.orderFlow.icebergs.find((item) => item.priceTicks === signal.priceTicks) : undefined;
        return {
          timeMs: signal.timeMs,
          priceTicks: signal.priceTicks,
          priceHighTicks: signal.priceHighTicks,
          kind: signal.kind,
          name: marker.name,
          inferred: marker.inferred || signal.label.toLowerCase().includes("inferred"),
          bias: signal.bias,
          strength: signal.strength,
          detail: signal.label && signal.label !== marker.name ? `${signal.label}. ${signal.detail}` : signal.detail,
          side: ice?.side,
          quantity: ice?.traded,
          refills: ice?.refills,
          durationMs: ice ? Math.max(0, ice.lastFillMs - ice.firstSeenMs) : undefined,
          hiddenEstimate: ice?.hiddenEstimate,
          confidence: ice?.confidence,
        };
      });
    return {
      ...baseReading,
      startMs,
      endMs,
      zoomed,
      fittedSpan,
      dots,
      svp,
      reclaims,
      guide,
      signals,
      bucketMs: sliceBucketMs(endMs - startMs, frame.plot.w),
      // Decimated for this time window and width. A vertical drag changes shiftTicks only, so this memo does not run again.
      priceSteps: lastPriceSteps(
        baseReading.candles,
        startMs,
        endMs,
        frame.plot.w,
        market.serverTimeMs,
        market.prints.at(-1)?.sourceTimeMs ?? null,
        {
          missingRanges: market.profiles.flatMap((profile) =>
            profile.missingRanges.map((range): readonly [number, number | null | undefined] => [range[0], range[1] ?? null]),
          ),
          sessionOpenMs: market.orderFlow.tpo.sessionOpenMs ?? null,
        },
      ),
    };
  }, [baseReading, viewWindow, market.historyMinutes, market.serverTimeMs, market.prints, market.historyWatermarkMs, market.orderFlow, market.profiles, layout, reclaims, sessionProfile, svp]);

  // Dragging only moves the price window. Aggregations above stay put for the life of the drag (REQUIREMENTS.md NFR-2).
  const range = useMemo(() => shiftPriceRange(sceneBase.zoomed, shiftTicks), [sceneBase, shiftTicks]);
  const scene = useMemo(() => ({ ...sceneBase, range }), [sceneBase, range]);
  useLayoutEffect(() => {
    sceneRef.current = scene;
    shiftRef.current = shiftTicks;
    priceZoomRef.current = viewWindow.priceZoom;
    spanRef.current = viewWindow.spanMs;
    offsetRef.current = viewWindow.offsetMs;
    historyRef.current = market.historyMinutes * 60_000;
    onReadingRef.current = onReading;
    if (layout.centerPrice !== lockProp.current) {
      lockHeld.current = layout.centerPrice;
      lockProp.current = layout.centerPrice;
    }
    releaseLockRef.current = () => {
      if (!lockHeld.current) return;
      lockHeld.current = false;
      onReadingRef.current((current) => (current.centerPrice ? { ...current, centerPrice: false } : current));
    };
  });

  useEffect(() => {
    if (!layout.centerPrice) return;
    const id = window.setInterval(() => {
      if (!lockHeld.current) return;
      const current = sceneRef.current;
      const price = current?.anchorTicks ?? null;
      if (!current || price == null) return;
      const target = centerPriceShift(current.zoomed, price);
      const next = stepCenterShift(shiftRef.current, target);
      if (next === shiftRef.current) return;
      shiftRef.current = next;
      setShiftTicks(next);
    }, CENTER_FOLLOW_MS);
    return () => window.clearInterval(id);
  }, [layout.centerPrice]);

  const linePrice = hover && layout.showPriceLine ? priceAt(scene.priceSteps, hover.timeMs) : null;
  const onPriceLine =
    hover !== null &&
    linePrice !== null &&
    pointerOnPriceLine(hover.priceTicks, linePrice, scene.range, scene.frame.plot.h);
  const readout = hoverReadout({
    spec: market.instrument,
    timeMs: hover?.timeMs ?? null,
    priceTicks: hover?.priceTicks ?? null,
    historyWatermarkMs: market.historyWatermarkMs,
    heat: scene.heatColumns,
    dots: scene.dots,
    timeBucketMs: scene.bucketMs,
    linePriceTicks: tip === null && onPriceLine ? linePrice : null,
  });

  useEffect(() => {
    const surface = prepareSurface(canvasRef.current, width, height);
    if (!surface || width < 8 || height < 8) return;
    const lastPrint = market.prints.at(-1);
    const painted = drawBookmap(surface, {
      frame: scene.frame,
      startMs: scene.startMs,
      endMs: scene.endMs,
      lowTicks: scene.range.low,
      highTicks: scene.range.high,
      heatColumns: scene.heatColumns,
      heatMode: layout.heatMode,
      heatDim: layout.heatDim,
      heatContrast: layout.heatContrast,
      heatAutoContrast: layout.heatAutoContrast,
      heatLowPercentile: layout.heatLowPercentile,
      heatHighPercentile: layout.heatHighPercentile,
      historyWatermarkMs: market.historyWatermarkMs,
      candles: scene.candles,
      showCandles: layout.showCandles,
      showPriceLine: layout.showPriceLine,
      priceSteps: scene.priceSteps,
      eventDotRadius: eventDotRadius(layout.eventDotSize),
      dots: scene.dots,
      levels: scene.levels,
      emphasizeNodes: layout.emphasizeNodes || layout.preset === "rips",
      showBbo,
      bboStale: scene.bboStale,
      bestBid: market.liquidity.bestBid ?? null,
      bestAsk: market.liquidity.bestAsk ?? null,
      showPnc,
      signals: scene.signals,
      reclaims: scene.reclaims,
      guide: showPnc ? scene.guide : null,
      cob: scene.cob,
      svp: scene.svp,
      volume: scene.strip,
      cvdPoints: market.orderFlow.cvdPoints,
      cvdSummary: scene.summary,
      spec: market.instrument,
      lastPriceTicks: lastPrint?.priceTicks ?? scene.candles.at(-1)?.c ?? null,
      hover: null,
    });
    setHeatScale((current) => (sameHeatScale(current, painted) ? current : painted));
  }, [scene, layout, market, width, height, showBbo, showPnc, fontEpoch, theme]);

  useEffect(() => {
    const surface = prepareSurface(overlayRef.current, width, height);
    if (!surface || width < 8 || height < 8) return;
    drawBookmapHover(surface, {
      frame: scene.frame,
      startMs: scene.startMs,
      endMs: scene.endMs,
      lowTicks: scene.range.low,
      highTicks: scene.range.high,
      spec: market.instrument,
      hover,
    });
  }, [hover, scene.frame, scene.startMs, scene.endMs, scene.range.low, scene.range.high, market.instrument, width, height, fontEpoch, theme]);

  // The wheel is native because React's listener is passive and cannot stop the page from scrolling.
  // The plot and the time strip zoom time. The PRICE column, and Shift+wheel on the plot, zoom price (D-36).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (event: WheelEvent) => {
      const current = sceneRef.current;
      if (!current) return;
      const local = localPoint(stage, event.clientX, event.clientY);
      const where = hitZone(current.frame, local.x, local.y);
      const priceWheel = where === "price" || (where === "plot" && event.shiftKey);
      const timeWheel = where === "plot" || where === "time";
      if (!priceWheel && !timeWheel) return;
      const delta = priceWheelDelta(event);
      if (delta === 0) return;
      const factor = delta > 0 ? chartZoomOut : chartZoomIn;
      if (priceWheel) {
        event.preventDefault();
        releaseLockRef.current();
        const fraction = current.frame.plot.h > 0 ? (local.y - current.frame.plot.y) / current.frame.plot.h : 0.5;
        // Refs, not the updater: a second notch can arrive before React runs a queued update.
        const next = zoomPriceAbout(priceZoomRef.current, shiftRef.current, current.fittedSpan, fraction, factor);
        priceZoomRef.current = next.priceZoom;
        shiftRef.current = next.shiftTicks;
        onWindow((w) => ({ ...w, priceZoom: next.priceZoom }));
        setShiftTicks(next.shiftTicks);
        return;
      }
      const fraction = current.frame.plot.w > 0 ? (local.x - current.frame.plot.x) / current.frame.plot.w : 0.5;
      const next = zoomTimeAbout(spanRef.current, offsetRef.current, fraction, factor, historyRef.current);
      // At the span limit the page can still scroll. A notch that moves the window keeps the pointer on the chart.
      if (next.spanMs === spanRef.current && next.offsetMs === offsetRef.current) return;
      event.preventDefault();
      spanRef.current = next.spanMs;
      offsetRef.current = next.offsetMs;
      onWindow((w) => ({ ...w, spanMs: next.spanMs, offsetMs: next.offsetMs }));
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, [onWindow]);

  useEffect(() => {
    if (!displayOpen) return;
    const close = (event: Event) => {
      if (!displayRef.current?.contains(event.target as Node)) setDisplayOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDisplayOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [displayOpen]);

  const fractionAt = (clientY: number) => {
    const stage = stageRef.current;
    const current = sceneRef.current;
    if (!stage || !current || current.frame.plot.h <= 0) return 0.5;
    const local = localPoint(stage, 0, clientY);
    return (local.y - current.frame.plot.y) / current.frame.plot.h;
  };

  const applyZoom = (zoom: number, shift: number, fittedSpan: number, fraction: number, factor: number) => {
    const next = zoomPriceAbout(zoom, shift, fittedSpan, fraction, factor);
    shiftRef.current = next.shiftTicks;
    setShiftTicks(next.shiftTicks);
    onWindow((current) => ({ ...current, priceZoom: next.priceZoom }));
  };

  const beginPinch = () => {
    const points = [...pointersRef.current.values()];
    const current = sceneRef.current;
    if (points.length < 2 || !current) return;
    const a = points[0];
    const b = points[1];
    if (!a || !b) return;
    const stage = stageRef.current;
    const fractionX = stage && current.frame.plot.w > 0 ? (localPoint(stage, (a.x + b.x) / 2, 0).x - current.frame.plot.x) / current.frame.plot.w : 0.5;
    pinchRef.current = {
      dx: Math.max(1, Math.abs(a.x - b.x)),
      dy: Math.max(1, Math.abs(a.y - b.y)),
      zoom: priceZoomRef.current,
      shift: shiftRef.current,
      fractionY: fractionAt((a.y + b.y) / 2),
      fittedSpan: current.fittedSpan,
      spanMs: spanRef.current,
      offsetMs: offsetRef.current,
      fractionX,
    };
    dragRef.current = null;
    setDragging(false);
  };

  const updatePinch = () => {
    const pinch = pinchRef.current;
    const points = [...pointersRef.current.values()];
    if (!pinch || points.length < 2) return;
    const a = points[0];
    const b = points[1];
    if (!a || !b) return;
    const dx = Math.max(1, Math.abs(a.x - b.x));
    const dy = Math.max(1, Math.abs(a.y - b.y));
    const timeFactor = pinchAxisFactor(pinch.dx, dx);
    // A pixel of vertical jitter in a sideways pinch is not a price zoom, so Lock stays on.
    const priceFactor = Math.abs(dy - pinch.dy) < PINCH_PRICE_DEADBAND_PX ? 1 : pinchAxisFactor(pinch.dy, dy);
    if (priceFactor !== 1) releaseLockRef.current();
    const time = zoomTimeAbout(pinch.spanMs, pinch.offsetMs, pinch.fractionX, timeFactor, historyRef.current);
    const price = zoomPriceAbout(pinch.zoom, pinch.shift, pinch.fittedSpan, pinch.fractionY, priceFactor);
    spanRef.current = time.spanMs;
    offsetRef.current = time.offsetMs;
    priceZoomRef.current = price.priceZoom;
    shiftRef.current = price.shiftTicks;
    setShiftTicks(price.shiftTicks);
    onWindow((w) => ({ ...w, spanMs: time.spanMs, offsetMs: time.offsetMs, priceZoom: price.priceZoom }));
  };

  const plotPoint = (event: { readonly clientX: number; readonly clientY: number }) => {
    const stage = stageRef.current;
    if (!stage || width < 8 || height < 8) return null;
    const { x, y } = localPoint(stage, event.clientX, event.clientY);
    if (hitZone(scene.frame, x, y) !== "plot") return null;
    const scales = bookmapScales(scene.frame, scene.startMs, scene.endMs, scene.range.low, scene.range.high);
    return { timeMs: scales.time.fromPx(x), priceTicks: scales.price.fromPx(y) };
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(".bookmap-hint, .bookmap-key")) return;
    placeTip(event.clientX, event.clientY);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2) {
      beginPinch();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const stage = stageRef.current;
    if (!stage) return;
    const { x, y } = localPoint(stage, event.clientX, event.clientY);
    const where = hitZone(scene.frame, x, y);
    if (where === "price") {
      releaseLockRef.current();
      const fraction = scene.frame.plot.h > 0 ? (y - scene.frame.plot.y) / scene.frame.plot.h : 0.5;
      dragRef.current = {
        kind: "zoom",
        pointer: event.pointerId,
        y: event.clientY,
        zoom: viewWindow.priceZoom,
        shift: shiftTicks,
        fraction,
        fittedSpan: scene.fittedSpan,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    const point = plotPoint(event);
    // COB, SVP, the volume strip and the CVD subchart are not the price plot, so a press there does not pan.
    if (!point) return;
    setHover(point);
    const span = scene.range.high - scene.range.low;
    dragRef.current = {
      kind: "pan",
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      ticks: clampPriceShift(shiftTicks, span),
      offsetMs: offsetRef.current,
      spanMs: Math.max(1, scene.endMs - scene.startMs),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const up = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (dragRef.current?.pointer !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };

  const resetPrice = () => {
    const historyMs = market.historyMinutes * 60_000;
    setShiftTicks(0);
    shiftRef.current = 0;
    priceZoomRef.current = 1;
    spanRef.current = historyMs;
    offsetRef.current = 0;
    releaseLockRef.current();
    onWindow(() => ({ spanMs: historyMs, offsetMs: 0, priceZoom: 1 }));
  };

  const centerOnLast = () => {
    const current = sceneRef.current;
    const price = current?.anchorTicks ?? null;
    if (!current || price == null) return;
    const shift = centerPriceShift(current.zoomed, price);
    shiftRef.current = shift;
    setShiftTicks(shift);
  };

  const dismissHint = () => {
    setShowHint(false);
    try {
      sessionStorage.setItem(ZOOM_HINT_KEY, "dismissed");
    } catch {
      // A private window can refuse storage. The hint still stays closed until the next visit.
    }
  };

  const zoomBy = (factor: number) => {
    // The +/− buttons are a price zoom about the middle, so they release Lock the way the tooltip says.
    releaseLockRef.current();
    applyZoom(viewWindow.priceZoom, shiftTicks, scene.fittedSpan, 0.5, factor);
  };

  const placeTip = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const local = localPoint(stage, clientX, clientY);
    if (hitZone(scene.frame, local.x, local.y) !== "plot") {
      setTip(null);
      return;
    }
    const scales = bookmapScales(scene.frame, scene.startMs, scene.endMs, scene.range.low, scene.range.high);
    const events: ChartEvent[] = [
      ...scene.signals,
      ...(showPnc
        ? scene.reclaims.map((reclaim) => ({
            kind: "FailedReclaim",
            name: `Failed reclaim · ${reclaim.name}`,
            inferred: true,
            timeMs: reclaim.timeMs,
            priceTicks: reclaim.priceTicks,
            detail: FAILED_RECLAIM_NOTE,
          }))
        : []),
    ];
    const hit = eventUnderPointer(
      events,
      local.x,
      local.y,
      (event) => ({
        x: scales.time.toPx(event.timeMs),
        y: scales.price.toPx(event.priceTicks),
      }),
      eventHitRadius(layout.eventDotSize),
    );
    if (!hit) {
      setTip(null);
      return;
    }
    const anchor = { x: scales.time.toPx(hit.timeMs), y: scales.price.toPx(hit.priceTicks) };
    const box = tooltipBox(anchor.x, anchor.y, scene.frame.plot);
    setTip({ ...box, lines: eventTooltipLines(hit, market.instrument) });
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pointersRef.current.size >= 2) {
      if (!pinchRef.current) beginPinch();
      updatePinch();
      return;
    }
    const drag = dragRef.current;
    if (drag && drag.pointer === event.pointerId && drag.kind === "pan") {
      // While Lock is on the 150 ms step owns the price shift. A sideways drag writes time only, or the two fight.
      let pan = drag;
      if (lockHeld.current && Math.abs(event.clientY - drag.y) >= LOCK_RELEASE_DRAG_PX) {
        releaseLockRef.current();
        pan = { ...drag, y: event.clientY, ticks: shiftRef.current };
        dragRef.current = pan;
      }
      if (!lockHeld.current) {
        const span = scene.range.high - scene.range.low;
        const ticks = clampPriceShift(pan.ticks + dragShiftTicks(event.clientY - pan.y, scene.range, scene.frame.plot.h), span);
        shiftRef.current = ticks;
        setShiftTicks(ticks);
      }
      const offsetMs = panOffsetMs(pan.offsetMs, event.clientX - pan.x, pan.spanMs, scene.frame.plot.w, historyRef.current);
      offsetRef.current = offsetMs;
      onWindow((w) => ({ ...w, offsetMs }));
    } else if (drag && drag.pointer === event.pointerId && drag.kind === "zoom") {
      applyZoom(drag.zoom, drag.shift, drag.fittedSpan, drag.fraction, priceAxisZoomFactor(event.clientY - drag.y));
    }
    const point = plotPoint(event);
    setHover(point);
    placeTip(event.clientX, event.clientY);
    const stage = stageRef.current;
    if (stage) {
      const { x, y } = localPoint(stage, event.clientX, event.clientY);
      stage.style.cursor = hitZone(scene.frame, x, y) === "price" ? "ns-resize" : "";
    }
  };

  const bookNote = !market.status.depthSubscribed ? "depth not subscribed" : !scene.bookKnown ? "book recovering" : null;

  return (
    <section className="bookmap" aria-label={`Order Flow ${market.root}`}>
      <div className="bookmap-controls" role="toolbar" aria-label="Order Flow controls">
        <fieldset>
          <legend>Preset</legend>
          <Hint label="Nodes (HVN/LVN)" text={hints.presetNodes}>
            {(hint) => (
              <button type="button" {...hint} aria-pressed={layout.preset === "rips"} onClick={() => onReading((current) => withRipsPreset(current, true))}>
                Nodes (HVN/LVN)
              </button>
            )}
          </Hint>
          <Hint label="Value area (POC/VAH/VAL)" text={hints.presetValueArea}>
            {(hint) => (
              <button type="button" {...hint} aria-pressed={layout.preset === "standard"} onClick={() => onReading((current) => withRipsPreset(current, false))}>
                Value area (POC/VAH/VAL)
              </button>
            )}
          </Hint>
        </fieldset>
        <fieldset>
          <legend>Heat</legend>
          <Hint label="Intensity" text={hints.heatIntensity}>
            {(hint) => (
              <button type="button" {...hint} aria-pressed={layout.heatMode === "intensity"} onClick={() => onReading((current) => ({ ...current, heatMode: "intensity" }))}>
                Intensity
              </button>
            )}
          </Hint>
          <Hint label="Flow ±" text={hints.heatFlow}>
            {(hint) => (
              <button type="button" {...hint} aria-pressed={layout.heatMode === "flow"} onClick={() => onReading((current) => ({ ...current, heatMode: "flow" }))}>
                Flow ±
              </button>
            )}
          </Hint>
        </fieldset>
        <fieldset>
          <legend>Price</legend>
          <button type="button" aria-label="Zoom price in" onClick={() => zoomBy(chartZoomIn)}>
            +
          </button>
          <button type="button" aria-label="Zoom price out" onClick={() => zoomBy(chartZoomOut)}>
            −
          </button>
          <button type="button" onClick={resetPrice}>
            Fit
          </button>
          <button type="button" aria-label="Center price" disabled={scene.anchorTicks == null} onClick={centerOnLast}>
            Center
          </button>
          <button
            type="button"
            aria-label="Lock center"
            aria-pressed={layout.centerPrice}
            title="Keep the last price in the middle. A vertical drag or a price zoom, including + and −, turns this off. A sideways drag does not."
            onClick={() => {
              const next = !layout.centerPrice;
              if (next) centerOnLast();
              onReading((current) => ({ ...current, centerPrice: next }));
            }}
          >
            Lock
          </button>
        </fieldset>
        <div className="bookmap-display" ref={displayRef}>
          <button type="button" aria-expanded={displayOpen} aria-controls="bookmap-display-panel" onClick={() => setDisplayOpen((open) => !open)}>
            Display
          </button>
          {displayOpen && (
          <div className="bookmap-display-panel" id="bookmap-display-panel">
            <div className="bookmap-display-item">
              <Hint label="Dimming" text={hints.displayDimming}>
                {(hint) => (
                  <fieldset {...hint}>
                    <legend>Dimming</legend>
                    {heatDimPresets.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        aria-pressed={layout.heatDim === preset.value}
                        onClick={() => onReading((current) => ({ ...current, heatDim: preset.value }))}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </fieldset>
                )}
              </Hint>
            </div>
            <div className="bookmap-display-item">
              <Hint label="Min dot" text={hints.displayMinDot}>
                {(hint) => (
                  <fieldset {...hint}>
                    <legend>Min dot</legend>
                    {dotSizePresets.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        aria-pressed={layout.dotMinQuantity === preset.value}
                        onClick={() => onReading((current) => ({ ...current, dotMinQuantity: preset.value }))}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </fieldset>
                )}
              </Hint>
            </div>
            <div className="bookmap-display-item">
              <Hint label="Event dots" text={hints.displayEventDots}>
                {(hint) => (
                  <fieldset {...hint}>
                    <legend>Event dots</legend>
                    {eventDotSizeSteps.map((step) => (
                      <button
                        key={step.value}
                        type="button"
                        aria-pressed={layout.eventDotSize === step.value}
                        onClick={() => onReading((current) => ({ ...current, eventDotSize: step.value }))}
                      >
                        {step.label}
                      </button>
                    ))}
                  </fieldset>
                )}
              </Hint>
            </div>
            <div className="bookmap-display-item">
              <Hint label="Candles Overlay" text={hints.displayCandles}>
                {(hint) => (
                  <button type="button" {...hint} aria-pressed={layout.showCandles} onClick={() => onReading((current) => ({ ...current, showCandles: !current.showCandles }))}>
                    Candles Overlay
                  </button>
                )}
              </Hint>
            </div>
            <div className="bookmap-display-item">
              <Hint label="Price line" text={hints.displayPriceLine}>
                {(hint) => (
                  <button type="button" {...hint} aria-pressed={layout.showPriceLine} onClick={() => onReading((current) => ({ ...current, showPriceLine: !current.showPriceLine }))}>
                    Price line
                  </button>
                )}
              </Hint>
            </div>
            <div className="bookmap-display-item">
              <Hint label="BBO Lines" text={hints.displayBbo}>
                {(hint) => (
                  <button type="button" {...hint} aria-pressed={showBbo} onClick={() => setShowBbo((on) => !on)}>
                    BBO Lines
                  </button>
                )}
              </Hint>
            </div>
            <div className="bookmap-display-item">
              <Hint label="PNC & Trail Guide" text={hints.displayPnc}>
                {(hint) => (
                  <button type="button" {...hint} aria-pressed={showPnc} onClick={() => setShowPnc((on) => !on)}>
                    PNC & Trail Guide
                  </button>
                )}
              </Hint>
            </div>
            <div className="bookmap-display-item">
              <Hint label="Bottom Volume Strip" text={hints.displayVolume}>
                {(hint) => (
                  <button type="button" {...hint} aria-pressed={showVolume} onClick={() => setShowVolume((on) => !on)}>
                    Bottom Volume Strip
                  </button>
                )}
              </Hint>
            </div>
            <div className="bookmap-display-item">
              <Hint label="CVD Subchart" text={hints.displayCvd}>
                {(hint) => (
                  <button type="button" {...hint} aria-pressed={showCvd} onClick={() => setShowCvd((on) => !on)}>
                    CVD Subchart
                  </button>
                )}
              </Hint>
            </div>
            <div className="bookmap-display-item">
              <Hint label="Event key" text={hints.displayKey}>
                {(hint) => (
                  <button type="button" {...hint} aria-pressed={showKey} onClick={() => setShowKey((on) => !on)}>
                    Event key
                  </button>
                )}
              </Hint>
            </div>
          </div>
          )}
        </div>
        <HeatLegend
          mode={layout.heatMode}
          scale={heatScale}
          autoContrast={layout.heatAutoContrast}
          lowPercentile={layout.heatLowPercentile}
          highPercentile={layout.heatHighPercentile}
          contrast={layout.heatContrast}
        />
      </div>
      {bookNote && (
        <p className="bookmap-note" role="note">
          {bookNote}
        </p>
      )}
      <div
        className={dragging ? "bookmap-stage bookmap-stage--dragging" : "bookmap-stage"}
        ref={stageRef}
        title="Shift+wheel zooms price. Scroll the plot to zoom time. Drag the PRICE scale to stretch it. Drag the plot to move time and price. Center puts the last price in the middle. Lock keeps it there. Double-click fits."
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => {
          setHover(null);
          setTip(null);
          if (stageRef.current) stageRef.current.style.cursor = "";
        }}
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest(".bookmap-hint, .bookmap-key")) return;
          resetPrice();
        }}
      >
        <canvas ref={canvasRef} aria-hidden="true" />
        <canvas ref={overlayRef} aria-hidden="true" />
        {showHint && (
          <p className="bookmap-hint">
            Scroll the plot to zoom time. Drag the PRICE scale to zoom price. Drag the plot to move. Center recenters price. Lock holds the last price in the middle.
            <button type="button" onClick={dismissHint}>
              Dismiss
            </button>
          </p>
        )}
        {showKey && (
          <ul className="bookmap-key" aria-label="Event key" style={{ right: Math.max(0, width - scene.frame.plot.w) + 8, pointerEvents: "none" }}>
            {eventMarkers.map((marker) => (
              <li key={marker.kind}>
                <span
                  className={marker.inferred ? "swatch swatch-hollow" : "swatch"}
                  style={{ background: marker.inferred ? "transparent" : `var(--${marker.token})`, borderColor: `var(--${marker.token})` }}
                />
                {marker.name}
              </li>
            ))}
          </ul>
        )}
        {tip && (
          <div className="bookmap-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
            {tip.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}
      </div>
      <dl className="bookmap-readout" aria-label="Order Flow readout">
        <div>
          <dt>Time</dt>
          <dd>{readout.timeMs === null ? "—" : formatLocalTime(readout.timeMs)}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd>{readout.priceText}</dd>
        </div>
        <div>
          <dt>Slice VWAP</dt>
          <dd>{readout.slice?.vwapText ?? "—"}</dd>
        </div>
        <div>
          <dt>Buy</dt>
          <dd className="up">{readout.slice?.buyText ?? "—"}</dd>
        </div>
        <div>
          <dt>Sell</dt>
          <dd className="down">{readout.slice?.sellText ?? "—"}</dd>
        </div>
        <div>
          <dt>Resting bid</dt>
          <dd className="bid">{readout.bidText}</dd>
        </div>
        <div>
          <dt>Resting ask</dt>
          <dd className="ask">{readout.askText}</dd>
        </div>
        {readout.slice === null && (
          <div>
            <dt>Slice</dt>
            <dd>{readout.sliceText}</dd>
          </div>
        )}
        <div>
          <dt>Event</dt>
          <dd>{tip?.lines[0] ?? "—"}</dd>
        </div>
        <div>
          <dt>Last</dt>
          <dd>
            {scene.summary.lastPriceTicks === null
              ? "—"
              : `${formatTicks(scene.summary.lastPriceTicks, market.instrument)} · CVD ${scene.summary.note}`}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * The heat key at the right of the controls: the cutoffs the ramp maps between, and nothing computed past them (the
 * maintainer's ruling). Intensity shows the five heat stops between the low and high cutoff, with the
 * percentile pair when auto-contrast set them (a linear ramp) or "log" for the fixed scale, from zero to the largest
 * size in view. Flow keys added and pulled depth up to ±the largest change in view. A contrast other than 1 is noted
 * beside them: it moves where the colours fall, not the cutoffs.
 */
function HeatLegend(props: {
  readonly mode: LayoutSettings["heatMode"];
  readonly scale: BookmapHeatScale | null;
  readonly autoContrast: boolean;
  readonly lowPercentile: number;
  readonly highPercentile: number;
  readonly contrast: number;
}) {
  const low = props.scale ? formatQty(props.scale.low) : "0";
  const high = props.scale ? formatQty(props.scale.high) : "—";
  const contrast = props.contrast === 1 ? null : `contrast ${formatContrast(props.contrast)}×`;
  const contrastLabel = contrast ? `, ${contrast}` : "";
  if (props.mode === "flow") {
    return (
      <figure className="bookmap-heat" aria-label={`Heat scale: depth added and pulled, logarithmic up to a change of ±${high} contracts${contrastLabel}`}>
        <span>Flow</span>
        <span className="bookmap-heat-swatch bookmap-heat-added" aria-hidden="true" />
        <span>added</span>
        <span className="bookmap-heat-swatch bookmap-heat-pulled" aria-hidden="true" />
        <span>pulled</span>
        <span className="bookmap-heat-max">±{high}</span>
        {contrast && <span>{contrast}</span>}
      </figure>
    );
  }
  const pair = props.autoContrast ? `p${props.lowPercentile}–p${props.highPercentile}` : null;
  const label = `Heat scale from ${low} to ${high} contracts${
    pair ? `, auto-contrast ${ordinal(props.lowPercentile)} to ${ordinal(props.highPercentile)} percentile` : ", logarithmic"
  }${contrastLabel}`;
  return (
    <figure className="bookmap-heat" aria-label={label}>
      <span>Resting</span>
      <div className="bookmap-heat-scale">
        <div className="bookmap-heat-bar" />
        <div className="bookmap-heat-ticks">
          <span>{low}</span>
          <span>{high}</span>
        </div>
      </div>
      <span>{pair ?? "log"}</span>
      {contrast && <span>{contrast}</span>}
    </figure>
  );
}

/** A contrast factor as the slider sets it: up to two decimals, no trailing zeros (0.5, 1.25, 2). */
function formatContrast(value: number): string {
  return String(Number(value.toFixed(2)));
}

function ordinal(value: number): string {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][value % 10] ?? "th");
  return `${value}${suffix}`;
}

function sameHeatScale(left: BookmapHeatScale | null, right: BookmapHeatScale | null): boolean {
  return left === right || (left !== null && right !== null && left.low === right.low && left.high === right.high);
}
