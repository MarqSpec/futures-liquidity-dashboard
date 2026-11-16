import { describe, expect, it } from "vitest";

import css from "./index.css?raw";

// The app frame, status bar and favorites rules of the design system, read from the stylesheet by selector.

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** True when a rule whose selector list holds `selector` exactly declares `declaration`. */
function has(selector: string, declaration: string): boolean {
  const wanted = declaration.replace(/\s+/g, " ").trim();
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = (match[1] ?? "").split(",").map((part) => part.replace(/\s+/g, " ").trim());
    if (list.includes(selector) && (match[2] ?? "").replace(/\s+/g, " ").includes(wanted)) return true;
  }
  return false;
}

const tab = '.view-tabs button[role="tab"]';

describe("index.css top bar", () => {
  it("should draw the bar on the low surface with a variant rule below when the top bar renders", () => {
    expect([has(".top-bar", "background: var(--surface-low)"), has(".top-bar", "border-bottom: 1px solid var(--outline-variant)")]).toEqual([true, true]);
  });

  it("should wrap when the window is narrow", () => {
    expect(has(".top-bar", "flex-wrap: wrap")).toBe(true);
  });

  it("should set the view tabs 32px tall and muted at rest when they are not selected", () => {
    expect([has(tab, "height: 32px"), has(tab, "color: var(--on-surface-muted)"), has(tab, "background: transparent")]).toEqual([true, true, true]);
  });

  it("should lift a tab to the surface colour with the hover layer when it is hovered", () => {
    expect([has(`${tab}:hover`, "background: var(--state-hover)"), has(`${tab}:hover`, "color: var(--on-surface)")]).toEqual([true, true]);
  });

  it("should draw a 2px primary indicator under the selected tab when it is selected", () => {
    const selected = `${tab}[aria-selected="true"]`;

    expect([has(selected, "color: var(--on-surface)"), has(`${selected}::after`, "height: 2px"), has(`${selected}::after`, "background: var(--primary)")]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("should keep the selected tab off the tonal fill when it is selected", () => {
    expect(has(`${tab}[aria-selected="true"]`, "background: transparent")).toBe(true);
  });

  it("should show the open session pill in the live colours when the market is open", () => {
    expect([has(".pill-open", "color: var(--status-live-text)"), has(".pill-open", "border-color: var(--status-live)")]).toEqual([true, true]);
  });

  it("should draw a dot before the hub word in the state colour when the hub state shows", () => {
    expect([
      has(".hub::before", "background: currentColor"),
      has(".hub-connected", "color: var(--status-live-text)"),
      has(".hub-reconnecting", "color: var(--status-simulated)"),
      has(".hub-disconnected", "color: var(--error)"),
    ]).toEqual([true, true, true, true]);
  });
});

describe("index.css status bar", () => {
  it("should set the last price in the extra-large data style when the bar renders", () => {
    expect([has(".last-price", "font: 600 20px/24px var(--font-mono)"), has(".last-price", "color: var(--on-surface)")]).toEqual([true, true]);
  });

  it("should set stats as a muted label over a mono value when a stat renders", () => {
    expect([has(".status-bar .stat", "color: var(--on-surface-muted)"), has(".status-bar .stat strong", "font: 500 12px/16px var(--font-mono)")]).toEqual([true, true]);
  });

  it("should tint the change by its sign when the session moved", () => {
    expect([has(".status-bar .stat strong.up", "color: var(--up)"), has(".status-bar .stat strong.down", "color: var(--down)")]).toEqual([true, true]);
  });

  it("should make a status chip 20px with the small radius and mono 700 text when the bar renders", () => {
    expect([
      has(".status-bar .chip", "height: 20px"),
      has(".chip", "border-radius: var(--radius-sm)"),
      has(".status-bar .chip", "font: 700 12px/16px var(--font-mono)"),
    ]).toEqual([true, true, true]);
  });

  it("should fill a chip with its status colour and its own text colour when the chip is filled", () => {
    expect([
      has(".chip-live", "background: var(--status-live)"),
      has(".chip-live", "color: var(--on-status-live)"),
      has(".chip-degraded", "background: var(--status-degraded)"),
      has(".chip-degraded", "color: var(--on-status-degraded)"),
    ]).toEqual([true, true, true, true]);
  });

  it("should draw the provenance chip as an outline in its text colour when it is outlined", () => {
    expect([has(".status-bar .chip-outline", "border-color: currentColor"), has(".chip-outline.chip-live", "color: var(--status-live-text)")]).toEqual([true, true]);
  });

  it("should put the event line at the right in muted mono when the bar renders", () => {
    expect([has(".feed-line", "margin-left: auto"), has(".feed-line", "color: var(--on-surface-muted)"), has(".feed-line", "var(--font-mono)")]).toEqual([true, true, true]);
  });

  it("should keep the stream error red inside the bar when an error alert shows", () => {
    expect(has(".status-bar .stat.error", "color: var(--error)")).toBe(true);
  });

  it("should space the regime labels 8px apart when both timeframes show", () => {
    expect(has(".status-bar .regimes", "gap: var(--space-8)")).toBe(true);
  });

  it("should tone the regime labels when a trend, range or unclear state shows", () => {
    expect([
      has(".regime-up", "color: var(--up)"),
      has(".regime-down", "color: var(--down)"),
      has(".regime-range", "color: var(--primary)"),
      has(".regime-unclear", "color: var(--status-simulated)"),
      has(".regime-warming", "color: var(--on-surface-muted)"),
    ]).toEqual([true, true, true, true, true]);
  });
});

describe("index.css favorites", () => {
  it("should outline the toggle and set it in mono when the menu is closed", () => {
    expect([has(".favorites-toggle", "border: 1px solid var(--outline)"), has(".favorites-toggle", "font-family: var(--font-mono)")]).toEqual([true, true]);
  });

  it("should raise the menu on the highest surface with the medium radius when it is open", () => {
    expect([
      has(".favorites-menu", "background: var(--surface-highest)"),
      has(".favorites-menu", "box-shadow: var(--elevation-2)"),
      has(".favorites-menu", "border-radius: var(--radius-md)"),
    ]).toEqual([true, true, true]);
  });

  it("should draw a touch as a pill with a muted count and a last-price third touch when the lane lists touches", () => {
    expect([
      has(".touch-lane li", "border-radius: var(--radius-full)"),
      has(".touch-lane li", "background: var(--surface-high)"),
      has(".touch-lane li", "color: var(--on-surface-muted)"),
      has(".touch-lane li.third", "color: var(--last-price)"),
    ]).toEqual([true, true, true, true]);
  });
});
