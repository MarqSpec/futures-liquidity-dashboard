import { describe, expect, it } from "vitest";

import bookmapSource from "../domain/bookmap.ts?raw";
import volumeDotsSource from "../domain/volumeDots.ts?raw";
import drawBookmapSource from "./drawBookmap.ts?raw";

// The Order Flow canvas takes every colour from the design tokens, the D-40 price line and its halos included since
// a separate change (they were named constants in domain/bookmap.ts).

/** `aggressorColor` is guarded on its own by the source test; this one covers the rest of the module. */
const AGGRESSOR_COLOR = /export function aggressorColor\([^)]*\)[^{]*\{[^}]*\}/g;

/** A hex colour, or a colour function with a literal channel; `rgba(${…})` built from a token is not a literal. */
const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(\s*[\d.]/gi;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Order Flow canvas sources", () => {
  it("should give no colour as a literal in components/drawBookmap.ts when its source is read", () => {
    // A source that failed to load would pass as empty: prove it is the drawing module first.
    expect(drawBookmapSource).toContain("export function drawBookmap(");

    expect(withoutComments(drawBookmapSource).match(LITERAL) ?? []).toEqual([]);
  });

  it("should give no colour as a literal in domain/volumeDots.ts outside aggressorColor when its source is read", () => {
    const source = withoutComments(volumeDotsSource);
    // The exclusion must cut exactly the one declaration, or it is excluding nothing (or too much).
    expect(source.match(AGGRESSOR_COLOR)).toHaveLength(1);
    expect(source).toContain("export function volumeDots(");

    expect(source.replace(AGGRESSOR_COLOR, "").match(LITERAL) ?? []).toEqual([]);
  });

  it("should give no colour as a literal in domain/bookmap.ts when its source is read", () => {
    expect(bookmapSource).toContain("export function priceSegments(");

    expect(withoutComments(bookmapSource).match(LITERAL) ?? []).toEqual([]);
  });
});
