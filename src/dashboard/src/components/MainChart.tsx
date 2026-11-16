import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { PINCH_AXIS_MIN_PX } from "../domain/bookmap.ts";
import type { TickSpec } from "../domain/format.ts";
import type { HeatColumn } from "../api/schemas.ts";
import {
  chartKeyHint,
  chartZoomIn,
  chartZoomOut,
  clampCursor,
  cursorCellKey,
  cursorFromTime,
  chartKeyAction,
  focusedBarReadout,
  initialCursor,
  nextAnnouncement,
  type ChartCursor,
  type LiveAnnouncement,
} from "../domain/chartCursor.ts";
import type { CrosshairStore } from "../hooks/crosshair.ts";
import { useCanvasFontEpoch } from "../hooks/useCanvasFontEpoch.ts";
import { useCanvasTheme } from "../hooks/useCanvasTheme.ts";
import { useElementSize } from "../hooks/useElementSize.ts";
import { prepareSurface } from "../lib/canvas.ts";
import { timeDraw } from "../lib/perfProbe.ts";
import { mainChartDrawKey } from "./chartDrawKey.ts";
import { drawMainChart, drawMainCrosshair, type MainChartGeometry, type MainChartModel, type Marker } from "./drawMainChart.ts";

/** Props of the main chart. */
export interface MainChartProps {
  readonly model: MainChartModel;
  readonly spec: TickSpec;
  readonly crosshair: CrosshairStore;
  readonly summary: string;
  /**
   * Zooms time by `factor` (> 1 shows more). `anchorFraction` is the plot position to keep (0 left, 1 right).
   * Returns false when the window cannot move, so the wheel can scroll the page.
   */
  readonly onZoomTime: (factor: number, anchorFraction?: number) => boolean | void;
  /** Zooms price by `factor` (> 1 shows more). */
  readonly onZoomPrice: (factor: number) => void;
  /** Pans by `deltaMs` (positive moves back in time). */
  readonly onPan: (deltaMs: number) => void;
  /** Pans price by `deltaTicks` (positive shows higher prices). */
  readonly onPanPrice: (deltaTicks: number) => void;
  /** Returns to the live edge with the default zoom. */
  readonly onReset: () => void;
}

interface Tooltip {
  readonly marker: Marker;
  readonly left: number;
  readonly top: number;
}

function nearest(markers: readonly Marker[], x: number, y: number): Marker | null {
  let best: Marker | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const d = Math.hypot(marker.x - x, marker.y - y);
    if (d <= marker.r + 3 && d < bestDistance) {
      best = marker;
      bestDistance = d;
    }
  }
  return best;
}

function columnAt(columns: readonly HeatColumn[], timeMs: number): HeatColumn | null {
  for (let index = columns.length - 1; index >= 0; index--) {
    const column = columns[index];
    if (column && timeMs >= column.t && timeMs < column.t + column.d) return column;
  }
  return null;
}

function readoutFor(model: MainChartModel, cursor: ChartCursor): string {
  const candle = model.candles.find((item) => item.t === cursor.barT) ?? null;
  return focusedBarReadout({
    root: model.market.instrument.root,
    spec: model.market.instrument,
    candle,
    priceTicks: cursor.priceTicks,
    column: candle ? columnAt(model.heatColumns, candle.t) : null,
  });
}

interface Pinch {
  dx: number;
  dy: number;
  readonly zoomX: boolean;
  readonly zoomY: boolean;
  readonly fraction: number;
}

function inPlot(geometry: MainChartGeometry, x: number, y: number): boolean {
  return x >= geometry.plotLeft && x <= geometry.plotWidth && y >= 0 && y <= geometry.plotHeight;
}

/**
 * The main chart: liquidity heatmap, one-minute candles, EMAs, VWAP, key levels, the agent's overlay and the
 * order-flow markers on shared time and price axes. A wheel over the plot zooms time about the instant under
 * the pointer (Shift+wheel zooms price). A drag that starts inside the plot pans time and price; one finger
 * does the same, and a second finger pinch-zooms. Double-click returns to the auto-fit view. The chart is also a keyboard control: arrows move
 * a cell, Shift+arrows pan, plus and minus zoom, Home returns to the auto-fit view.
 */
export function MainChart({ model, spec, crosshair, summary, onZoomTime, onZoomPrice, onPan, onPanPrice, onReset }: MainChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const geometryRef = useRef<MainChartGeometry | null>(null);
  const drawnKey = useRef("");
  const handlers = useRef({ onZoomTime, onZoomPrice, onPan, onPanPrice, onReset });
  const modelRef = useRef(model);
  const announced = useRef<LiveAnnouncement | null>(null);
  const cursorRef = useRef<ChartCursor | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [cursor, setCursor] = useState<ChartCursor | null>(null);
  const [hover, setHover] = useState<ChartCursor | null>(null);
  const [liveText, setLiveText] = useState("");
  const { width, height } = useElementSize(wrapRef);
  const fontEpoch = useCanvasFontEpoch();
  const theme = useCanvasTheme();

  useLayoutEffect(() => {
    handlers.current = { onZoomTime, onZoomPrice, onPan, onPanPrice, onReset };
    modelRef.current = model;
    cursorRef.current = cursor;
  });

  useEffect(() => {
    const key = mainChartDrawKey(model, width, height, globalThis.devicePixelRatio || 1, fontEpoch, theme);
    if (key === drawnKey.current && geometryRef.current) return;
    const surface = prepareSurface(baseRef.current, width, height);
    if (!surface) return;
    geometryRef.current = timeDraw(() => drawMainChart(surface, model));
    drawnKey.current = key;
  });

  useEffect(() => {
    const paint = () => {
      const surface = prepareSurface(overlayRef.current, width, height);
      const geometry = geometryRef.current;
      if (!surface || !geometry) return;
      const { timeMs, priceTicks } = crosshair.get();
      drawMainCrosshair(surface, geometry, spec, timeMs, priceTicks);
    };
    paint();
    return crosshair.subscribe(paint);
  }, [crosshair, width, height, spec, fontEpoch, theme]);

  const speak = (text: string, cell: string, immediate: boolean) => {
    const next = nextAnnouncement(announced.current, { text, cell, at: Date.now(), immediate });
    if (!next) return;
    announced.current = next;
    setLiveText(next.text);
  };

  const clamped = cursor ? clampCursor(cursor, model.candles, model.startMs, model.endMs, model.lowTicks, model.highTicks) : cursor;
  if (cursor && (!clamped || clamped.barT !== cursor.barT || clamped.priceTicks !== cursor.priceTicks)) {
    setCursor(clamped);
  }

  useEffect(() => {
    if (!cursor) return;
    const candle = modelRef.current.candles.find((item) => item.t === cursor.barT);
    crosshair.set({ timeMs: candle ? candle.t + candle.d / 2 : cursor.barT, priceTicks: cursor.priceTicks });
  }, [cursor, crosshair]);

  useEffect(() => {
    if (!cursor) return;
    const cell = cursorCellKey(cursor);
    speak(readoutFor(model, cursor), cell, announced.current?.cell !== cell);
  }, [cursor, model]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return undefined;
    let drag: { x: number; y: number; pointer: number } | null = null;
    let pinch: Pinch | null = null;
    const pointers = new Map<number, { x: number; y: number }>();

    const fingerGap = () => {
      const points = [...pointers.values()];
      const a = points[0];
      const b = points[1];
      if (!a || !b) return null;
      return { dx: Math.abs(a.x - b.x), dy: Math.abs(a.y - b.y), midX: (a.x + b.x) / 2 };
    };
    const beginPinch = (geometry: MainChartGeometry) => {
      const gap = fingerGap();
      if (!gap) return;
      drag = null;
      pinch = {
        dx: Math.max(1, gap.dx),
        dy: Math.max(1, gap.dy),
        zoomX: gap.dx >= PINCH_AXIS_MIN_PX,
        zoomY: gap.dy >= PINCH_AXIS_MIN_PX,
        fraction: (gap.midX - geometry.plotLeft) / Math.max(1, geometry.plotWidth - geometry.plotLeft),
      };
    };
    const applyPinch = () => {
      if (!pinch) return;
      const gap = fingerGap();
      if (!gap) return;
      const dx = Math.max(1, gap.dx);
      const dy = Math.max(1, gap.dy);
      if (pinch.zoomX && dx !== pinch.dx) {
        handlers.current.onZoomTime(pinch.dx / dx, pinch.fraction);
        pinch = { ...pinch, dx };
      }
      if (pinch.zoomY && dy !== pinch.dy) {
        handlers.current.onZoomPrice(pinch.dy / dy);
        pinch = { ...pinch, dy };
      }
    };

    const move = (event: PointerEvent) => {
      const geometry = geometryRef.current;
      if (!geometry) return;
      const x = event.offsetX;
      const y = event.offsetY;
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x, y });
      if (pinch && pointers.size >= 2) {
        applyPinch();
        return;
      }
      if (drag && drag.pointer === event.pointerId) {
        const dx = x - drag.x;
        const dy = y - drag.y;
        if (dx !== 0) {
          const msPerPx = (geometry.time.d1 - geometry.time.d0) / Math.max(1, geometry.plotWidth - geometry.plotLeft);
          handlers.current.onPan(dx * msPerPx);
        }
        if (dy !== 0) {
          const ticksPerPx = (geometry.price.d1 - geometry.price.d0) / Math.max(1, geometry.plotHeight);
          handlers.current.onPanPrice(dy * ticksPerPx);
        }
        drag = { x, y, pointer: drag.pointer };
      }
      const overPlot = inPlot(geometry, x, y);
      const timeMs = overPlot ? geometry.time.fromPx(x) : null;
      const priceTicks = overPlot ? geometry.price.fromPx(y) : null;
      crosshair.set({ timeMs, priceTicks });
      if (timeMs !== null && priceTicks !== null) {
        const current = modelRef.current;
        const next = cursorFromTime(current.candles, current.startMs, current.endMs, timeMs, priceTicks, current.lowTicks, current.highTicks);
        setHover((held) => {
          if (!next) return held === null ? held : null;
          if (held && held.barT === next.barT && held.priceTicks === next.priceTicks) return held;
          return next;
        });
      } else {
        setHover((held) => (held === null ? held : null));
      }
      const hit = overPlot && !drag ? nearest(geometry.markers, x, y) : null;
      setTooltip((current) => {
        if (!hit) return current === null ? current : null;
        if (current?.marker === hit) return current;
        return { marker: hit, left: Math.min(x + 14, geometry.plotWidth - 260), top: Math.max(4, y - 10) };
      });
    };
    const leave = () => {
      setTooltip(null);
      setHover(null);
      // — pointerleave must not drop a crosshair the keyboard placed
      const place = cursorRef.current;
      if (!place) {
        crosshair.set({ timeMs: null, priceTicks: null });
        return;
      }
      const current = modelRef.current;
      const candle = current.candles.find((item) => item.t === place.barT);
      crosshair.set({ timeMs: candle ? candle.t + candle.d / 2 : place.barT, priceTicks: place.priceTicks });
    };
    const down = (event: PointerEvent) => {
      const x = event.offsetX;
      const y = event.offsetY;
      pointers.set(event.pointerId, { x, y });
      const geometry = geometryRef.current;
      if (event.pointerType === "touch" && pointers.size > 1) {
        if (geometry && drag) beginPinch(geometry);
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      if (event.button !== 0 || !geometry) return;
      if (!inPlot(geometry, x, y)) return;
      drag = { x, y, pointer: event.pointerId };
      canvas.setPointerCapture(event.pointerId);
    };
    const up = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag?.pointer === event.pointerId) {
        drag = null;
        canvas.releasePointerCapture(event.pointerId);
      }
    };
    const wheel = (event: WheelEvent) => {
      const geometry = geometryRef.current;
      if (!geometry) return;
      const x = event.offsetX;
      const y = event.offsetY;
      if (!inPlot(geometry, x, y)) return;
      const factor = event.deltaY > 0 ? chartZoomOut : chartZoomIn;
      if (event.shiftKey) {
        event.preventDefault();
        handlers.current.onZoomPrice(factor);
        return;
      }
      const fraction = (x - geometry.plotLeft) / Math.max(1, geometry.plotWidth - geometry.plotLeft);
      // At the span limit the page can still scroll, the same as Order Flow.
      if (handlers.current.onZoomTime(factor, fraction) !== false) event.preventDefault();
    };
    const doubleClick = () => handlers.current.onReset();
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("dblclick", doubleClick);
    return () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("dblclick", doubleClick);
    };
  }, [crosshair]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const place = cursor ?? initialCursor(model.candles, model.startMs, model.endMs, model.lowTicks, model.highTicks);
    if (!place) return;
    const action = chartKeyAction(event.key, event.shiftKey, place, model.candles, model.startMs, model.endMs, model.lowTicks, model.highTicks);
    if (!action) return;
    event.preventDefault();
    if (action.type === "dismiss") {
      setCursor(null);
      setHover(null);
      setLiveText("");
      announced.current = null;
      crosshair.set({ timeMs: null, priceTicks: null });
      event.currentTarget.blur();
      return;
    }
    if (action.type === "reset") {
      onReset();
      return;
    }
    if (action.type === "pan") {
      onPan(action.deltaMs);
      return;
    }
    if (action.type === "zoom-time") {
      onZoomTime(action.factor);
      return;
    }
    if (action.type === "zoom-price") {
      onZoomPrice(action.factor);
      return;
    }
    setCursor(action.cursor);
  };

  const visibleCell = hover ?? cursor;
  const visibleReadout = visibleCell ? readoutFor(model, visibleCell) : "";

  return (
    <section className="pane pane-main" aria-label="Price, liquidity and order flow">
      {/* A canvas chart has no native interactive element. role=application is the widget that owns the keys. */}
      {/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div
        className="pane-canvas chart-surface"
        ref={wrapRef}
        tabIndex={0}
        role="application"
        aria-label={summary}
        aria-describedby="chart-key-hint"
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight + - Home Escape"
        onKeyDown={onKeyDown}
        onFocus={() => {
          setCursor((current) => current ?? initialCursor(model.candles, model.startMs, model.endMs, model.lowTicks, model.highTicks));
        }}
      >
      {/* oxlint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        <p className="visually-hidden">{summary}</p>
        <canvas ref={baseRef} aria-hidden="true" style={{ width, height }} />
        <canvas ref={overlayRef} className="pane-overlay pane-overlay-interactive" aria-hidden="true" style={{ width, height }} />
        <p id="chart-key-hint" className="chart-keys">
          {chartKeyHint}
        </p>
        {visibleReadout && (
          <p className="chart-readout" aria-hidden="true">
            {visibleReadout}
          </p>
        )}
        {tooltip && (
          <output className="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
            <div className="tooltip-title">{tooltip.marker.title}</div>
            {tooltip.marker.lines.map((line, i) => (
              // A marker's lines are fixed slots that never reorder.
              <div key={`${i}:${line}`}>{line}</div>
            ))}
          </output>
        )}
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {liveText}
      </div>
    </section>
  );
}
