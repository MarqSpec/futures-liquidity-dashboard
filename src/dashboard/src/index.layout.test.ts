import { describe, expect, it } from "vitest";

import css from "./index.css?raw";
import { declaration, topLevelRules } from "./test/cssRules.ts";

/**
 * The Detail chart stays in the viewport only when these rules are top-level. A missing brace nests them under
 * `.view > .workspace`, which is not where the panel lives, and a two-row grid puts the chart in an implicit auto row.
 */

function rowTracks(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }
  const tracks: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of value) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")" && depth > 0) {
      depth -= 1;
    }
    if (character === " " && depth === 0) {
      if (current.length > 0) {
        tracks.push(current);
      }
      current = "";
    } else {
      current += character;
    }
  }
  if (current.length > 0) {
    tracks.push(current);
  }
  return tracks;
}

const rules = topLevelRules(css);

describe("detail layout", () => {
  it("should give the instrument panel four rows when Detail stacks the status bar, the toolbar, the picker and the chart", () => {
    const rows = declaration(rules.get(".instrument-panel"), "grid-template-rows");

    expect(declaration(rules.get(".instrument-panel"), "display")).toBe("grid");
    expect(rowTracks(rows)).toEqual(["auto", "auto", "auto", "minmax(0, 1fr)"]);
  });

  it("should let the instrument panel fill the view when the chart must take the leftover viewport", () => {
    const panel = rules.get(".view > .instrument-panel");

    expect(declaration(panel, "flex")).toBe("1 1 0");
    expect(declaration(panel, "min-height")).toBe("0");
  });

  it("should scroll the product picker inside a capped panel when the list is taller than the cap", () => {
    const products = rules.get(".products");
    const scroll = rules.get(".products .scroll");

    expect(declaration(products, "display")).toBe("flex");
    expect(declaration(products, "flex-direction")).toBe("column");
    expect(declaration(products, "overflow")).toBe("hidden");
    expect(declaration(products, "max-height")).toBe("32vh");
    expect(declaration(products, "min-height")).toBe("0");
    expect(declaration(scroll, "overflow")).toBe("auto");
    expect(declaration(scroll, "min-height")).toBe("0");
    expect(declaration(rules.get(".products.collapsed"), "max-height")).toBe("none");
  });

  it("should stop the chart column growing from its canvas when the pane measures itself", () => {
    for (const selector of [".workspace", ".chart-column", ".placeholder"]) {
      expect(declaration(rules.get(selector), "min-height"), selector).toBe("0");
      expect(declaration(rules.get(selector), "overflow"), selector).toBe("hidden");
    }
  });

  it("should hide the chart key hint until the chart has keyboard focus", () => {
    expect(declaration(rules.get(".chart-keys"), "display")).toBe("none");
    expect(declaration(rules.get(".chart-surface:focus-visible .chart-keys"), "display")).toBe("block");
  });

  it("should keep the overview table filling the view when Detail's panel is a grid", () => {
    const overview = rules.get(".overview");

    expect(declaration(overview, "display")).toBe("flex");
    expect(declaration(overview, "flex")).toBe("1 1 0");
    expect(declaration(overview, "min-height")).toBe("0");
  });
});
