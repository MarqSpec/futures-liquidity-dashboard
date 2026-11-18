// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import css from "./index.css?raw";
import { plotWhollyInView } from "./lib/wheelGate.ts";
import { topLevelRules } from "./test/cssRules.ts";

// reference: ARCHITECTURE.md D-53
// A chart plot taller than the box that scrolls it never comes wholly into view, so the wheel gate never lets it zoom.
// jsdom does no layout, so these resolve the rules' heights at a window height and hand the result to the gate.

const rules = topLevelRules(css);

/** The top-level rules inside the first `@media` block whose prelude is `query`, read the same way as the others. */
function mediaRules(query: string): Map<string, string> {
  const start = css.indexOf(query);
  const open = css.indexOf("{", start);
  let depth = 1;
  let cursor = open + 1;
  while (depth > 0 && cursor < css.length) {
    depth += css[cursor] === "{" ? 1 : css[cursor] === "}" ? -1 : 0;
    cursor += 1;
  }
  return topLevelRules(css.slice(open + 1, cursor - 1));
}

const phone = mediaRules("@media (max-width: 640px)");

/**
 * Every value the cascade can give `property` from `bodies`, rules in source order: the last rule that declares it
 * wins, and within it a browser keeps the last value it can parse, so each one is a value some browser uses.
 */
function declarations(bodies: readonly (string | undefined)[], property: string): readonly string[] {
  const pattern = new RegExp(`(?:^|[;{}])\\s*${property}\\s*:\\s*([^;]+)`, "gi");
  const declared = bodies.map((body) =>
    [...(body ?? "").matchAll(pattern)].map((match) => (match[1] ?? "").trim().replace(/\s+/g, " ")),
  );
  return declared.findLast((values) => values.length > 0) ?? [];
}

/**
 * A length in CSS pixels at a window `height` px tall: px, the viewport-height units and min()/max() of them. On a
 * desktop window every viewport-height unit is the same height, so `vh`, `svh`, `lvh` and `dvh` all resolve alike.
 */
function resolve(value: string, height: number): number {
  const call = value.match(/^(min|max)\((.*)\)$/);
  if (call) {
    const args = (call[2] ?? "").split(",").map((part) => resolve(part.trim(), height));
    return call[1] === "min" ? Math.min(...args) : Math.max(...args);
  }
  const length = value.match(/^(-?[\d.]+)(px|vh|svh|lvh|dvh)$/);
  if (!length) throw new Error(`unresolvable length: ${value}`);
  const amount = Number.parseFloat(length[1] ?? "NaN");
  return length[2] === "px" ? amount : (amount * height) / 100;
}

/** The tallest the rule lets its box be at rest: its min-height, under every declaration a browser might keep. */
function restingHeights(bodies: readonly (string | undefined)[], height: number): readonly number[] {
  return declarations(bodies, "min-height").map((value) => resolve(value, height));
}

const charts = [
  // 420; the indicator dock's 168 px minimum now sits under it.
  ["the Order Flow stage", [rules.get(".bookmap-stage")], 252],
  ["the Order Flow stage on a phone", [rules.get(".bookmap-stage"), phone.get(".bookmap-stage")], 280],
  ["the Detail price pane", [rules.get(".pane-main")], 220],
] as const;

describe("chart height cap", () => {
  describe.each(charts)("%s", (_name, bodies, minimum) => {
    it.each([160, 240, 380, minimum - 1])("should never grow taller than a window %i px tall", (height) => {
      const resting = restingHeights(bodies, height);
      const caps = declarations(bodies, "max-height").map((value) => resolve(value, height));

      expect(resting.length).toBeGreaterThan(0);
      for (const value of resting) expect(value).toBeLessThanOrEqual(height);
      // Without a cap a flex chart could still grow past the window: the minimum only says how short it may be.
      expect(caps.length).toBeGreaterThan(0);
      for (const value of caps) expect(value).toBeLessThanOrEqual(height);
    });

    it.each([minimum, 800, 1200])("should keep its minimum of today in a window %i px tall", (height) => {
      for (const value of restingHeights(bodies, height)) expect(value).toBe(minimum);
      for (const value of declarations(bodies, "max-height")) expect(resolve(value, height)).toBeGreaterThanOrEqual(height);
    });
  });
});

describe("chart height cap and the wheel gate", () => {
  function place(element: Element, top: number, width: number, height: number): void {
    vi.spyOn(element, "getBoundingClientRect").mockImplementation(
      () => ({ x: 0, y: top, left: 0, top, right: width, bottom: top + height, width, height, toJSON: () => ({}) }) as DOMRect,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  // The narrow layout scrolls #root, as tall as the window. The plot is as tall as the chart's box (no strips).
  it.each([
    ["the Order Flow plot", 380, [rules.get(".bookmap-stage")]],
    ["the Detail plot", 200, [rules.get(".pane-main")]],
  ] as const)("should let the wheel zoom %s once it is scrolled wholly into view in an 800x%i window", (_name, height, bodies) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(height);
    const scroller = document.createElement("div");
    scroller.style.overflow = "auto";
    const chart = document.createElement("div");
    scroller.append(chart);
    document.body.append(scroller);
    const chartHeight = Math.max(...restingHeights(bodies, height));
    place(scroller, 0, 800, height);
    // Scrolled so the chart's top meets the scroller's top: the furthest into view a box can come.
    place(chart, 0, 800, chartHeight);

    expect(plotWhollyInView(chart, { x: 0, y: 0, w: 800, h: chartHeight })).toBe(true);
  });
});
