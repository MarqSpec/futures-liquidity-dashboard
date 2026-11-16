import { fonts, orderFlowFonts } from "../theme.ts";

// Canvas text does not wait for a web font: a canvas drawn before IBM Plex Mono loads keeps the fallback face until
// it redraws. The watcher asks the browser for each canvas face and bumps an epoch once they are ready.

/** The part of `document.fonts` the watcher uses. */
export interface FontSource {
  load(font: string): Promise<unknown>;
  readonly ready: Promise<unknown>;
}

/** Counts font loads that should redraw the canvases; an external store for `useSyncExternalStore`. */
export interface CanvasFontWatcher {
  /** 0 until the canvas faces have loaded, then 1. */
  readonly epoch: () => number;
  /** Starts loading on the first subscriber; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** A watcher over `source()`'s font set for the given canvas `font` strings. */
export function canvasFontWatcher(source: () => FontSource | undefined, faces: readonly string[]): CanvasFontWatcher {
  let epoch = 0;
  let started = false;
  const listeners = new Set<() => void>();
  const start = () => {
    if (started) return;
    started = true;
    const set = source();
    if (!set) return;
    // Settled, not all: one face that fails must not hold back the redraw of the faces that loaded.
    void Promise.allSettled(faces.map((face) => set.load(face)))
      .then(async (results) => {
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            console.warn(`Canvas font "${faces[index]}" did not load; that text keeps the fallback face.`, result.reason);
          }
        });
        if (!results.some((result) => result.status === "fulfilled")) return;
        await set.ready;
        epoch += 1;
        for (const listener of [...listeners]) listener();
      })
      .catch((error: unknown) => console.warn("Canvas fonts did not settle; the canvases keep the fallback face.", error));
  };
  return {
    epoch: () => epoch,
    subscribe: (listener) => {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Every face a canvas sets for text: the shared data faces and the Order Flow canvas's own. */
export const canvasFaces: readonly string[] = [...new Set([...Object.values(fonts), ...Object.values(orderFlowFonts)])];

/** The app's watcher over `document.fonts` (none outside a browser). */
export const canvasFonts: CanvasFontWatcher = canvasFontWatcher(
  () => (typeof document === "undefined" ? undefined : document.fonts),
  canvasFaces,
);
