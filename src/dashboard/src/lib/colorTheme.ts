import type { ThemeId } from "../design/tokenFile.ts";
import { color } from "../design/tokens.ts";
import { canvasTheme } from "../theme.ts";

// The viewer's theme: Terminal (dark) or Light. With no stored choice it follows the OS light/dark setting, live; a
// choice is kept in this browser only, under one localStorage key, never in the saved layout or on the server.

/** A theme, or `system` to follow the OS setting. */
export type ThemeChoice = ThemeId | "system";

/** The one key the choice is stored under; no key means `system`. */
export const THEME_STORAGE_KEY = "futures-liquidity-dashboard.theme";

/** The OS setting the default follows. */
export const LIGHT_SCHEME_QUERY = "(prefers-color-scheme: light)";

/** The part of a `MediaQueryList` the theme reads. */
export interface SchemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/** Where the theme reads and writes: each may be missing, and `storage` may throw (blocked site data). */
export interface ColorThemeEnvironment {
  readonly storage: () => Storage | undefined;
  readonly media: () => SchemeQuery | undefined;
  /** Shows `theme`: the page and the canvases. */
  readonly apply: (theme: ThemeId) => void;
}

export interface ColorThemeState {
  readonly choice: ThemeChoice;
  /** What `choice` resolves to now. */
  readonly theme: ThemeId;
}

/** The theme as an external store for `useSyncExternalStore`. */
export interface ColorTheme {
  readonly state: () => ColorThemeState;
  /** Starts the theme on the first subscriber; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Applies `choice` at once and stores it (`system` removes the key). */
  readonly choose: (choice: ThemeChoice) => void;
  /** Reads the stored choice and the OS setting, applies the theme and follows the OS setting. Runs once. */
  readonly start: () => void;
}

function isTheme(value: unknown): value is ThemeId {
  return value === "dark" || value === "light";
}

function readChoice(storage: () => Storage | undefined): ThemeChoice {
  try {
    const stored = storage()?.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function writeChoice(storage: () => Storage | undefined, choice: ThemeChoice): void {
  try {
    const store = storage();
    if (choice === "system") store?.removeItem(THEME_STORAGE_KEY);
    else store?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // A blocked or full store only means the choice is not remembered; it still applies now.
  }
}

/** The theme over `environment`. */
export function createColorTheme(environment: ColorThemeEnvironment): ColorTheme {
  let state: ColorThemeState = { choice: "system", theme: "dark" };
  let media: SchemeQuery | undefined;
  let started = false;
  const listeners = new Set<() => void>();

  const resolve = (choice: ThemeChoice): ThemeId => (choice === "system" ? (media?.matches ? "light" : "dark") : choice);

  const update = (choice: ThemeChoice, notify: boolean) => {
    const next: ColorThemeState = { choice, theme: resolve(choice) };
    if (started && next.choice === state.choice && next.theme === state.theme) return;
    const themeChanged = !started || next.theme !== state.theme;
    state = next;
    if (themeChanged) environment.apply(next.theme);
    if (notify) for (const listener of [...listeners]) listener();
  };

  const start = () => {
    if (started) return;
    const choice = readChoice(environment.storage);
    try {
      media = environment.media();
    } catch {
      media = undefined;
    }
    media?.addEventListener("change", () => update(state.choice, true));
    update(choice, false);
    started = true;
  };

  return {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
      };
    },
    choose: (choice) => {
      start();
      writeChoice(environment.storage, choice);
      update(choice, true);
    },
    start,
  };
}

/** Puts `theme` on the page: `data-theme` and `color-scheme` on `<html>`, and its `surface` as the theme-color meta. */
export function applyDocumentTheme(doc: Document, theme: ThemeId): void {
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "light" ? "light" : "dark";
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement("meta");
    meta.name = "theme-color";
    doc.head.append(meta);
  }
  meta.content = color("surface", theme);
}

/** The app's theme: the browser's localStorage and OS setting, applied to the page and the canvases together. */
export const colorTheme: ColorTheme = createColorTheme({
  storage: () => globalThis.localStorage,
  media: () => globalThis.matchMedia?.(LIGHT_SCHEME_QUERY),
  apply: (theme) => {
    canvasTheme.set(theme);
    if (typeof document !== "undefined") applyDocumentTheme(document, theme);
  },
});
