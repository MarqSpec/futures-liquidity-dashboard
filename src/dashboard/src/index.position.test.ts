import { describe, expect, it } from "vitest";

import css from "./index.css?raw";
import { cascaded, topLevelRules } from "./test/cssRules.ts";

// The simulated position's lines take their colours from the theme's tokens, and the layer that holds them passes
// every press it does not own to the chart beneath, so a plain drag still pans (REQUIREMENTS.md FR-72, ARCHITECTURE.md D-58).

const rules = topLevelRules(css);

describe("simulated position styles", () => {
  it.each([
    [".position-line-entry", "var(--primary)"],
    [".position-line-stop", "var(--danger)"],
    [".position-line-target", "var(--support)"],
  ])("should colour %s from its token in both themes", (selector, token) => {
    expect(cascaded(rules, selector, "color")).toBe(token);
  });

  it("should let presses through the layer and take them only on a line", () => {
    expect(cascaded(rules, ".position-layer", "pointer-events")).toBe("none");
    expect(cascaded(rules, ".position-line", "pointer-events")).toBe("auto");
    expect(cascaded(rules, ".position-layer", "z-index")).toBe("var(--z-chart-overlay)");
  });

  it("should mark SIMULATED in the simulated status colour", () => {
    expect(cascaded(rules, ".position-badge", "color")).toBe("var(--status-simulated)");
  });
});
