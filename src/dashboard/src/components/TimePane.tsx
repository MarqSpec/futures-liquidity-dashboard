import { useEffect, useRef } from "react";

import type { CrosshairStore } from "../hooks/crosshair.ts";
import { useCanvasFontEpoch } from "../hooks/useCanvasFontEpoch.ts";
import { useCanvasTheme } from "../hooks/useCanvasTheme.ts";
import { useElementSize } from "../hooks/useElementSize.ts";
import { prepareSurface, type Surface } from "../lib/canvas.ts";
import { colors } from "../theme.ts";
import type { SeriesPaneGeometry } from "./drawSeriesPane.ts";

/** Props of a time-aligned canvas pane. */
export interface TimePaneProps {
  /** The pane's accessible name. */
  readonly label: string;
  /** A text summary of what the pane shows, for assistive technology. */
  readonly summary: string;
  readonly className?: string;
  readonly crosshair: CrosshairStore;
  /** Draws the pane; called after every render with a cleared surface. */
  readonly draw: (surface: Surface) => SeriesPaneGeometry;
}

/** A canvas pane on the shared time axis, with a crosshair layer that follows the pointer in every pane. */
export function TimePane({ label, summary, className, crosshair, draw }: TimePaneProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const geometryRef = useRef<SeriesPaneGeometry | null>(null);
  const { width, height } = useElementSize(wrapRef);
  // Read so the pane re-renders, and its draw effect runs again, once the canvas fonts load and when the theme changes.
  useCanvasFontEpoch();
  const theme = useCanvasTheme();

  useEffect(() => {
    const surface = prepareSurface(baseRef.current, width, height);
    if (surface) {
      geometryRef.current = draw(surface);
    }
  });

  useEffect(() => {
    const paint = () => {
      const surface = prepareSurface(overlayRef.current, width, height);
      const geometry = geometryRef.current;
      const t = crosshair.get().timeMs;
      if (!surface || !geometry || t === null) return;
      const x = Math.round(geometry.time.toPx(t)) + 0.5;
      if (x < 0 || x > geometry.plotWidth) return;
      surface.ctx.strokeStyle = colors.crosshair;
      surface.ctx.setLineDash([3, 3]);
      surface.ctx.beginPath();
      surface.ctx.moveTo(x, 0);
      surface.ctx.lineTo(x, height);
      surface.ctx.stroke();
    };
    paint();
    return crosshair.subscribe(paint);
  }, [crosshair, width, height, theme]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return undefined;
    const move = (event: PointerEvent) => {
      const geometry = geometryRef.current;
      if (!geometry) return;
      const x = event.offsetX;
      crosshair.set({ timeMs: x <= geometry.plotWidth ? geometry.time.fromPx(x) : null, priceTicks: null });
    };
    const leave = () => crosshair.set({ timeMs: null, priceTicks: null });
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    return () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
    };
  }, [crosshair]);

  return (
    <section className={`pane ${className ?? ""}`} aria-label={label}>
      <div className="pane-canvas" ref={wrapRef}>
        <p className="visually-hidden">{summary}</p>
        <canvas ref={baseRef} aria-hidden="true" style={{ width, height }} />
        <canvas ref={overlayRef} className="pane-overlay" aria-hidden="true" style={{ width, height }} />
      </div>
    </section>
  );
}
