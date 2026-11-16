import { describe, expect, it } from "vitest";

import css from "./index.css?raw";

// The Order Flow screen on the design system: the controls on surface-container, the Display menu a surface-highest
// menu, the heat legend from the heat-* stops, and a readout whose values carry their side's colour.

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every rule whose selector list names `selector` exactly, whitespace collapsed. */
function declarations(selector: string): string {
  const found: string[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = (match[1] ?? "").split(",").map((part) => part.replace(/\s+/g, " ").trim());
    if (list.includes(selector)) found.push((match[2] ?? "").replace(/\s+/g, " "));
  }
  return found.join(" ");
}

describe("index.css Order Flow", () => {
  it("should lay the controls on surface-container and open the Display menu as a raised surface-highest menu when the screen renders", () => {
    expect(declarations(".bookmap-controls")).toContain("background: var(--surface-container)");
    expect([
      declarations(".bookmap-display-panel").includes("background: var(--surface-highest)"),
      declarations(".bookmap-display-panel").includes("border-radius: var(--radius-md)"),
      declarations(".bookmap-display-panel").includes("box-shadow: var(--elevation-2)"),
    ]).toEqual([true, true, true]);
  });

  it("should paint the heat legend bar through the five heat stops in order when the key renders", () => {
    expect(declarations(".bookmap-heat-bar")).toContain(
      "linear-gradient(90deg, var(--heat-0) 0%, var(--heat-25) 25%, var(--heat-50) 50%, var(--heat-75) 75%, var(--heat-100) 100%)",
    );
  });

  it("should colour the readout's buy, sell, bid and ask values by side, in data-sm on surface-low when the readout renders", () => {
    expect([
      declarations(".bookmap-readout .up"),
      declarations(".bookmap-readout .down"),
      declarations(".bookmap-readout .bid"),
      declarations(".bookmap-readout .ask"),
    ]).toEqual(["color: var(--up);", "color: var(--down);", "color: var(--bid);", "color: var(--ask);"].map((rule) => ` ${rule} `));
    expect(declarations(".bookmap-readout")).toContain("background: var(--surface-low)");
    expect(declarations(".bookmap-readout")).toContain("font: 400 11px/16px var(--font-mono)");
  });
});
