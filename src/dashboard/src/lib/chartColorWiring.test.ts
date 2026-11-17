// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { CHART_COLORS_STORAGE_KEY } from "./chartColorOverrides.ts";

// The app itself puts the viewer's chart colours on the page, through the real colorTheme and chartColorStore: at
// start-up, on a theme switch and on a later colour change, and when another window changes the stored colours.
// No test here calls applyDocumentChartColors itself.

const UP = "#123456";

/** The app modules, imported after the stored colours are in place, as on a reload. */
async function app() {
  const { colorTheme } = await import("./colorTheme.ts");
  const { chartColorStore } = await import("./chartColorOverrides.ts");
  return { colorTheme, chartColorStore };
}

/** What another window does: it writes the key, and this window hears a storage event. */
function writeFromAnotherWindow(value: string | null, key: string | null = CHART_COLORS_STORAGE_KEY): void {
  if (key !== null) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } else {
    localStorage.clear();
  }
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

const style = () => document.documentElement.style;

describe("the app's chart colours on the page", () => {
  // One app per file, as in the browser: the steps run in order on the same colorTheme and chartColorStore.
  it("should restyle the page at start-up, on a theme switch, on a colour change and on a reset", async () => {
    localStorage.setItem(CHART_COLORS_STORAGE_KEY, JSON.stringify({ dark: { up: UP }, light: {} }));
    const { colorTheme, chartColorStore } = await app();

    // Start-up in Terminal, with up stored: the page reads it, and every alias of it follows through var(--up).
    colorTheme.start();
    expect(style().getPropertyValue("--up")).toBe(UP);

    // A later colour change restyles the page at once, with no theme change.
    chartColorStore.set("dark", "bias-bullish", "#654321");
    expect(style().getPropertyValue("--bias-bullish")).toBe("#654321");

    // A switch to Light takes Terminal's colours off the page and puts Light's on.
    colorTheme.choose("light");
    expect(style().getPropertyValue("--up")).toBe("");
    chartColorStore.set("light", "up", "#abcdef");
    expect(style().getPropertyValue("--up")).toBe("#abcdef");

    // A reset returns the page to the theme's own value.
    chartColorStore.reset("light", "up");
    expect(style().getPropertyValue("--up")).toBe("");

    colorTheme.choose("system");
  });

  it("should follow another window that changes or clears the stored colours, and ignore other keys", async () => {
    const { colorTheme, chartColorStore } = await app();
    colorTheme.choose("dark");
    const listener = vi.fn();
    const unsubscribe = chartColorStore.subscribe(listener);

    writeFromAnotherWindow(JSON.stringify({ dark: { vwap: "#0a0b0c" }, light: {} }));
    expect(chartColorStore.overrides().dark).toEqual({ vwap: "#0a0b0c" });
    expect(style().getPropertyValue("--vwap")).toBe("#0a0b0c");
    expect(listener).toHaveBeenCalledTimes(1);

    writeFromAnotherWindow("x", "futures-liquidity-dashboard.theme");
    expect(listener).toHaveBeenCalledTimes(1);

    writeFromAnotherWindow(null, null);
    expect(chartColorStore.overrides()).toEqual({ dark: {}, light: {} });
    expect(style().getPropertyValue("--vwap")).toBe("");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    colorTheme.choose("system");
  });
});
