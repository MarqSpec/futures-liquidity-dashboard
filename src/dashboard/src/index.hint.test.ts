import { describe, expect, it } from "vitest";

import css from "./index.css?raw";

// The hint on the design system: a scrim-tooltip surface with radius-sm and elevation-2, text from tokens so both
// themes follow, and a touch toggle that only shows where a pointer cannot hover.

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(selector: string): string {
  const found: string[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = (match[1] ?? "").split(",").map((part) => part.replace(/\s+/g, " ").trim());
    if (list.includes(selector)) found.push((match[2] ?? "").replace(/\s+/g, " "));
  }
  return found.join(" ");
}

describe("index.css hint", () => {
  it("should draw the hint on scrim-tooltip with radius-sm and elevation-2 when it shows", () => {
    const tip = declarations(".hint-tip");

    expect([
      tip.includes("background: var(--scrim-tooltip)"),
      tip.includes("border-radius: var(--radius-sm)"),
      tip.includes("box-shadow: var(--elevation-2)"),
      tip.includes("font: 400 11px/15px var(--font-sans)"),
    ]).toEqual([true, true, true, true]);
  });

  it("should take every colour of the hint from a token so Terminal and Light both follow", () => {
    const block = `${declarations(".hint-tip")} ${declarations(".hint-toggle")}`;

    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it("should keep the hint wrapper out of layout and hide the toggle unless the pointer cannot hover", () => {
    expect(declarations(".hint")).toContain("display: contents");
    expect(declarations(".hint-toggle")).toContain("display: none");
    expect(stripped).toMatch(/@media \(hover: none\), \(pointer: coarse\) \{\s*\.hint-toggle \{\s*display: inline-flex;/);
  });

  it("should not show the hint while it is hidden", () => {
    expect(declarations(".hint-tip[hidden]")).toContain("display: none");
  });
});

describe("index.css hint toggle in a joined group", () => {
  it("should put the touch toggle after the strip, with no overlap and its own corners, when it sits in a joined group", () => {
    for (const selector of [".bookmap-controls fieldset button.hint-toggle", ".segmented button.hint-toggle"]) {
      const block = declarations(selector);

      expect([
        block.includes("order: 1"),
        block.includes("margin-left: var(--space-2)"),
        block.includes("border-radius: var(--radius-sm)"),
        block.includes("padding: 0"),
      ]).toEqual([true, true, true, true]);
    }
  });

  it("should declare the toggle override after the joined-group rules so it wins the specificity tie", () => {
    const joined = stripped.lastIndexOf(".bookmap-controls fieldset button:only-of-type");
    const toggle = stripped.indexOf(".bookmap-controls fieldset button.hint-toggle");

    expect(joined).toBeGreaterThan(0);
    expect(toggle).toBeGreaterThan(joined);
  });
});
