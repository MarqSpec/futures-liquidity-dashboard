import { describe, expect, it } from "vitest";

import css from "./index.css?raw";
import { cascaded, topLevelRules } from "./test/cssRules.ts";

// Overlays on a Detail chart sit on a scrim, at the chart-overlay layer, and never take the pointer.

const rules = topLevelRules(css);

describe("chart overlays", () => {
  it.each([
    [".chart-keys", "var(--scrim-chart)", "var(--radius-xs)"],
    [".chart-readout", "var(--scrim-chart)", "var(--radius-xs)"],
    [".depth-note", "var(--scrim-tooltip)", "var(--radius-sm)"],
    [".tooltip", "var(--scrim-tooltip)", "var(--radius-sm)"],
  ])("should lay %s on its scrim at the chart-overlay layer when it is over a chart", (selector, scrim, radius) => {
    expect(cascaded(rules, selector, "background")).toBe(scrim);
    expect(cascaded(rules, selector, "border-radius")).toBe(radius);
    expect(cascaded(rules, selector, "box-shadow")).toBe("var(--elevation-2)");
    expect(cascaded(rules, selector, "z-index")).toBe("var(--z-chart-overlay)");
    expect(cascaded(rules, selector, "pointer-events")).toBe("none");
  });

  it("should let a later rule win when two rules set the same property", () => {
    const sample = topLevelRules(".a, .b { z-index: 1; } .a { z-index: 2; }");

    expect(cascaded(sample, ".a", "z-index")).toBe("2");
    expect(cascaded(sample, ".b", "z-index")).toBe("1");
    expect(cascaded(sample, ".c", "z-index")).toBeUndefined();
  });
});
