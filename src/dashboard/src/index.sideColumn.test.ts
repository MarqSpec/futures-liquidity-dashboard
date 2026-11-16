import { describe, expect, it } from "vitest";

import css from "./index.css?raw";
import { cascaded, declaration, topLevelRules } from "./test/cssRules.ts";

/** The Detail side column sits beside the charts and drops below them when the window is narrow. */

const rules = topLevelRules(css);
const px = (value: string | undefined) => Number.parseFloat(value ?? "NaN");

/** The rules inside the narrow-window block, which jsdom never applies, read the same way as the top-level ones. */
function narrowRules(): Map<string, string> {
  const start = css.indexOf("@media (max-width: 900px)");
  const open = css.indexOf("{", start);
  let depth = 1;
  let cursor = open + 1;
  while (depth > 0 && cursor < css.length) {
    depth += css[cursor] === "{" ? 1 : css[cursor] === "}" ? -1 : 0;
    cursor += 1;
  }
  return topLevelRules(css.slice(open + 1, cursor - 1));
}

describe("detail side column", () => {
  it("should wrap the side column under the charts when the window is narrow", () => {
    const workspace = rules.get(".workspace");

    expect(declaration(workspace, "display")).toBe("flex");
    expect(declaration(workspace, "flex-wrap")).toBe("wrap");
  });

  it("should wrap at the 900px breakpoint when the chart column asks for the room left beside the side column", () => {
    const chart = declaration(rules.get(".chart-column"), "flex") ?? "";
    const side = declaration(rules.get(".side-column"), "flex") ?? "";
    const chartBasis = px(chart.split(" ")[2]);
    const sideBasis = px(side.split(" ")[2]);

    expect(declaration(rules.get(".workspace"), "gap")).toBe("var(--space-8)");
    expect(sideBasis).toBe(300);
    // Exactly the 900px breakpoint, so the row wraps where the narrow-window rules start.
    expect(chartBasis + sideBasis + 8).toBe(900);
  });

  it("should never pin the side column to the viewport when it follows the charts", () => {
    const body = rules.get(".side-column") ?? "";

    expect(body).not.toMatch(/position\s*:\s*(sticky|fixed)/);
    expect(body).not.toMatch(/100vh/);
  });

  // jsdom does no layout, so this pins the rule: a wrapping row's line is as tall as its tallest item, and without a
  // bound the column grows to its content and the clipping workspace hides the lower panels instead of scrolling.
  it("should bound the side column to the workspace's height when the window is wide, so it scrolls instead of being clipped", () => {
    expect(declaration(rules.get(".workspace"), "overflow")).toBe("hidden");
    expect(declaration(rules.get(".side-column"), "overflow-y")).toBe("auto");
    expect(declaration(rules.get(".side-column"), "max-height")).toBe("100%");
  });

  it("should lift the bound when the window is narrow, so the column drops below the charts at its full height", () => {
    const side = narrowRules().get(".side-column");

    expect(declaration(side, "max-height")).toBe("none");
    expect(declaration(side, "overflow")).toBe("visible");
  });

  // The body is a flex column so the panel's content lays out as it did before the fold, and a flex display would
  // otherwise beat the hidden attribute.
  it("should take a folded section's body out of layout when its flex display would show it", () => {
    const body = rules.get(".ld-panel-body");

    expect(declaration(body, "display")).toBe("flex");
    expect(declaration(body, "flex-direction")).toBe("column");
    expect(declaration(rules.get(".ld-panel-body[hidden]"), "display")).toBe("none");
  });

  it("should draw a section's heading button as the heading itself, across the panel and at least 24px tall", () => {
    const fold = rules.get(".ld-fold");

    expect(declaration(fold, "display")).toBe("flex");
    expect(declaration(fold, "width")).toBe("100%");
    expect(declaration(fold, "height")).toBe("auto");
    expect(declaration(fold, "min-height")).toBe("24px");
    expect(declaration(fold, "background")).toBe("transparent");
    expect(declaration(fold, "border-color")).toBe("transparent");
    expect(declaration(fold, "font")).toBe("inherit");
    expect(declaration(rules.get(".ld-fold-title"), "justify-content")).toBe("space-between");
  });

  it("should drop the heading's bottom margin when a section is folded to it", () => {
    expect(declaration(rules.get(".ld-panel.collapsed .ld-panel-title"), "margin-bottom")).toBe("0");
  });

  it("should stack the panels with an 8px gap", () => {
    const side = rules.get(".side-column");

    expect(declaration(side, "display")).toBe("flex");
    expect(declaration(side, "flex-direction")).toBe("column");
    expect(declaration(side, "gap")).toBe("var(--space-8)");
  });

  it("should draw a panel as a surface-container with an outline-variant border and radius-sm", () => {
    const panel = rules.get(".ld-panel");

    expect(declaration(panel, "background")).toBe("var(--surface-container)");
    expect(declaration(panel, "border")).toBe("1px solid var(--outline-variant)");
    expect(declaration(panel, "border-radius")).toBe("var(--radius-sm)");
  });

  it("should tint the best rows and dash the spread row when the ladder is drawn", () => {
    expect(cascaded(rules, ".ld-ladder tr.best td", "background")).toBe("var(--highlight-best)");
    expect(cascaded(rules, ".ld-ladder tr.best td", "font-weight")).toBe("700");
    expect(cascaded(rules, ".ld-ladder tr.spread td", "border-block")).toBe("1px dashed var(--outline)");
    expect(cascaded(rules, ".ld-ladder td", "height")).toBe("var(--ladder-row)");
  });

  it("should leave no rule for the fold or the tab strip when the column is always shown", () => {
    for (const selector of [".more-panels", ".dom-strip", ".sidebar", ".tabpanel"]) {
      expect(rules.has(selector), selector).toBe(false);
    }
  });

  it("should colour a signal's dot and kind with the bias tokens, as the chart does", () => {
    for (const bias of ["bullish", "bearish", "neutral"]) {
      expect(cascaded(rules, `.ld-signal--${bias} .ld-dot`, "background"), bias).toBe(`var(--bias-${bias})`);
      expect(cascaded(rules, `.ld-signal--${bias} .kind`, "color"), bias).toBe(`var(--bias-${bias})`);
    }
  });

  it("should wrap a long signal detail rather than cut it off", () => {
    const detail = rules.get(".ld-signal .detail");

    expect(detail).not.toMatch(/text-overflow|white-space\s*:\s*nowrap/);
    expect(declaration(detail, "overflow-wrap")).toBe("anywhere");
  });
});

