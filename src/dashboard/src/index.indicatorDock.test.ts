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

  it("should keep the collapse button out of the scrolling tab list when the strip is narrow", () => {
    expect(declaration(rules.get(".indicator-strip"), "display")).toBe("flex");
    expect(declaration(rules.get(".indicator-tabs"), "flex")).toBe("1 1 auto");
    expect(declaration(rules.get(".indicator-strip .icon-button"), "flex")).toBe("none");
  });
});
