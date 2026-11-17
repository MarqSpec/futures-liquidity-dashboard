import { useSyncExternalStore } from "react";

import type { ThemeId } from "../design/tokenFile.ts";
import { canvasTheme } from "../theme.ts";


/** The canvas theme: a canvas component that reads it re-renders, and so redraws once, when the theme changes. */
export function useCanvasTheme(): ThemeId {
  return useSyncExternalStore(canvasTheme.subscribe, canvasTheme.current, canvasTheme.current);
}

/**
 * The canvas palette: the theme plus the viewer's chart colours for it. A canvas component that reads it re-renders,
 * and so redraws once, when the theme or a chart colour changes.
 */
export function useCanvasPalette(): string {
  return useSyncExternalStore(canvasTheme.subscribe, canvasTheme.palette, canvasTheme.palette);
}
