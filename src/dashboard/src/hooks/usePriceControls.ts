import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { CENTER_FOLLOW_MS, centerPriceShift, stepCenterShift, zoomPriceAbout } from "../domain/bookmap.ts";
import type { LayoutSettings } from "../domain/layout.ts";

/** What the price controls read from a chart at the moment they act. */
export interface PriceScene {
  /** The price range at the current zoom, before the vertical shift. */
  readonly zoomed: { readonly low: number; readonly high: number };
  /** The fitted price span that the zoom multiplies. */
  readonly fittedSpan: number;
  readonly priceZoom: number;
  readonly shiftTicks: number;
  /** The last traded price (`lastPriceAnchor`), or null before the first trade. */
  readonly anchorTicks: number | null;
}

/** How one chart tab hands its price state to the shared controls. */
export interface PriceControlsOptions {
  /** The saved Lock, `layout.centerPrice`: one setting for Detail and Order Flow. */
  readonly locked: boolean;
  readonly onReading: ((change: (current: LayoutSettings) => LayoutSettings) => void) | undefined;
  /** The chart's current price state, read when a control acts. Null before the chart has a scene. */
  readonly scene: () => PriceScene | null;
  /** Writes the vertical price shift. */
  readonly setShift: (shiftTicks: number) => void;
  /** Writes the shared `priceZoom`. */
  readonly setZoom: (priceZoom: number) => void;
  /** Restores the default view window. */
  readonly resetWindow: () => void;
}

/** The price actions both tabs call. Each is stable for the life of the chart. */
export interface PriceActions {
  /** False from the moment Lock is released, before the saved layout catches up. */
  readonly isLockHeld: () => boolean;
  /** Turns Lock off. Every price zoom, a vertical drag and Fit call this. */
  readonly releaseLock: () => void;
  /** + and −: zooms price by `factor` about the middle of the plot, and releases Lock. */
  readonly zoomBy: (factor: number) => void;
  /** Fit: the fitted price, the default window, and Lock off. */
  readonly fit: () => void;
  /** Center: puts the last price in the middle and leaves the zoom alone. */
  readonly center: () => void;
  /** Lock: turns it on (centring first) or off, on the saved layout. */
  readonly toggleLock: () => void;
}

/**
 * The +, −, Fit, Center and Lock behaviour of Detail and Order Flow, in one place so the two tabs cannot drift
 * apart (REQUIREMENTS.md FR-67, FR-68). While Lock is on, the last price is stepped back to the middle every
 * `CENTER_FOLLOW_MS`.
 */
export function usePriceControls(options: PriceControlsOptions): PriceActions {
  const optionsRef = useRef(options);
  const held = useRef(options.locked);
  const seenLock = useRef(options.locked);

  useLayoutEffect(() => {
    optionsRef.current = options;
    if (options.locked !== seenLock.current) {
      held.current = options.locked;
      seenLock.current = options.locked;
    }
  });

  const [actions] = useState<PriceActions>(() => {
    const releaseLock = () => {
      if (!held.current) return;
      held.current = false;
      optionsRef.current.onReading?.((current) => (current.centerPrice ? { ...current, centerPrice: false } : current));
    };
    const center = () => {
      const scene = optionsRef.current.scene();
      if (!scene || scene.anchorTicks == null) return;
      optionsRef.current.setShift(centerPriceShift(scene.zoomed, scene.anchorTicks, scene.fittedSpan));
    };
    return {
      isLockHeld: () => held.current,
      releaseLock,
      zoomBy: (factor) => {
        releaseLock();
        const scene = optionsRef.current.scene();
        if (!scene) return;
        const next = zoomPriceAbout(scene.priceZoom, scene.shiftTicks, scene.fittedSpan, 0.5, factor);
        optionsRef.current.setShift(next.shiftTicks);
        optionsRef.current.setZoom(next.priceZoom);
      },
      fit: () => {
        optionsRef.current.setShift(0);
        releaseLock();
        optionsRef.current.resetWindow();
      },
      center,
      toggleLock: () => {
        const next = !optionsRef.current.locked;
        if (next) center();
        optionsRef.current.onReading?.((current) => ({ ...current, centerPrice: next }));
      },
    };
  });

  useEffect(() => {
    if (!options.locked) return undefined;
    const id = window.setInterval(() => {
      if (!held.current) return;
      const scene = optionsRef.current.scene();
      if (!scene || scene.anchorTicks == null) return;
      const next = stepCenterShift(scene.shiftTicks, centerPriceShift(scene.zoomed, scene.anchorTicks, scene.fittedSpan));
      if (next !== scene.shiftTicks) optionsRef.current.setShift(next);
    }, CENTER_FOLLOW_MS);
    return () => window.clearInterval(id);
  }, [options.locked]);

  return actions;
}
