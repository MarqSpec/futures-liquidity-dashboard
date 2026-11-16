import { useSyncExternalStore } from "react";

import type { ThemeId } from "../design/tokenFile.ts";
import { canvasTheme } from "../theme.ts";


/** The canvas theme: a canvas component that reads it re-renders, and so redraws once, when the theme changes. */
export function useCanvasTheme(): ThemeId {
  return useSyncExternalStore(canvasTheme.subscribe, canvasTheme.current, canvasTheme.current);
}
