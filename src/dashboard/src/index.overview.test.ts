import { describe, expect, it } from "vitest";

import css from "./index.css?raw";

// The Overview's table rules from the design system: 24px rows ruled with outline-variant, the state-hover and the
// primary-container row, and a box that scrolls sideways. Each is read from the stylesheet by selector.

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the rule whose selector list is exactly `selector`. */
function block(selector: string): string {
  for (const rule of stripped.split("}")) {
    const [head = "", body = ""] = rule.split("{");
    if (head.trim() === selector) return body;
  }
  return "";
}

describe("Overview table rules", () => {
  it.each([
    [".overview-table td", /height:\s*24px/],
    [".overview-table tbody tr", /border-bottom:\s*1px solid var\(--outline-variant\)/],
    [".overview-table tbody tr:hover td", /background:\s*var\(--state-hover\)/],
    [".overview-table tbody tr.active td", /background:\s*var\(--primary-container\)/],
    [".overview-table tbody tr.active td", /color:\s*var\(--on-primary-container\)/],
    [".overview-box", /border:\s*1px solid var\(--outline-variant\)/],
    [".overview-box", /border-radius:\s*var\(--radius-sm\)/],
    [".overview-table th[aria-sort] .sort > span", /color:\s*var\(--primary\)/],
  ])("should set %s to %s", (selector, expected) => {
    expect(block(selector)).toMatch(expected);
  });
});

describe("Overview open row", () => {
  it("should declare the open row's fill after the hover fill so hovering it keeps the highlight", () => {
    const hover = stripped.indexOf(".overview-table tbody tr:hover td {");
    const open = stripped.indexOf(".overview-table tbody tr.active td {");
    expect([hover >= 0, open > hover]).toEqual([true, true]);
  });
});
