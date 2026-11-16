import { useSyncExternalStore } from "react";

import { canvasFonts, type CanvasFontWatcher } from "../lib/canvasFonts.ts";

/** The canvas font epoch: a canvas component that reads it re-renders, and so redraws, once the fonts load. */
export function useCanvasFontEpoch(watcher: CanvasFontWatcher = canvasFonts): number {
  return useSyncExternalStore(watcher.subscribe, watcher.epoch, watcher.epoch);
}
