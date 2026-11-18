import { describe, expect, it } from "vitest";

import css from "./index.css?raw";
import { declaration, topLevelRules } from "./test/cssRules.ts";

// A collapsed Detail indicator dock keeps only its tab strip, and the price chart takes the height it frees.

const rules = topLevelRules(css);

describe("indicator dock", () => {
  it("should shrink the collapsed dock to its tab strip when the viewer collapses it", () => {
    const collapsed = rules.get(".indicator-dock.collapsed");

    expect(declaration(collapsed, "flex")).toBe("none");
    expect(declaration(collapsed, "min-height")).toBe("0");
  });

  it("should take the hidden panel of a collapsed dock out of layout when its flex display would show it", () => {
    expect(declaration(rules.get(".indicator-panel"), "display")).toBe("flex");
    expect(declaration(rules.get(".indicator-panel[hidden]"), "display")).toBe("none");
  });

  it("should let the price chart grow into the freed height when the dock no longer claims it", () => {
    const flex = declaration(rules.get(".pane-main"), "flex");

    expect(flex?.split(" ")[0]).not.toBe("0");
    expect(flex?.split(" ")[2]).toBe("0");
    expect(declaration(rules.get(".indicator-dock"), "flex")).toBe("2.4 1 0");
  });

  it("should give the Order Flow stage the Detail chart's share of the height when the dock sits under it", () => {
    const stage = declaration(rules.get(".bookmap-stage"), "flex");

    expect(stage).toBe(declaration(rules.get(".pane-main"), "flex"));
    expect(stage).toBe("5 1 0");
  });

  it("should keep the Order Flow stage's and the dock's minimums within the 420 px the stage and its strips took, so the readout stays in the chart row", () => {
    const px = (value: string | undefined) => Number(/(\d+(?:\.\d+)?)px/.exec(value ?? "")?.[1] ?? Number.NaN);
    const stage = px(declaration(rules.get(".bookmap-stage"), "min-height"));
    const dock = px(declaration(rules.get(".indicator-dock"), "min-height"));

    expect(dock).toBe(168);
    expect(stage + dock).toBeLessThanOrEqual(420);
  });

  it("should keep the collapse button out of the scrolling tab list when the strip is narrow", () => {
    expect(declaration(rules.get(".indicator-strip"), "display")).toBe("flex");
    expect(declaration(rules.get(".indicator-tabs"), "flex")).toBe("1 1 auto");
    expect(declaration(rules.get(".indicator-strip .icon-button"), "flex")).toBe("none");
  });
});
