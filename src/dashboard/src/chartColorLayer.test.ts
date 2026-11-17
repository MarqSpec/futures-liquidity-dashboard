import { describe, expect, it } from "vitest";

// Every colour the app draws or styles inline passes the one override layer in theme.ts: no other module reads a colour
// token, and none writes a colour literal, so a viewer's chart colours reach every tab.

const sources = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./test/**", "!./design/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The names a source imports from a module whose path ends in `module`. */
function importedFrom(source: string, module: string): string[] {
  const pattern = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*["'][^"']*${module.replace(/[./]/g, "\\$&")}["']`, "g");
  return [...source.matchAll(pattern)].flatMap((match) => (match[1] ?? "").split(",").map((name) => name.trim().split(/\s+as\s+/)[0] ?? "")).filter(Boolean);
}

/** Hex colours, numeric rgb()/hsl() colours and named colours, outside comments. */
function colourLiterals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return code.match(/["'`]#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(\s*\d|["'`](?:white|black|red|green|blue|yellow|orange|gray|grey)["'`]/gi) ?? [];
}

describe("the chart colour override layer", () => {
  it("should be the only module that reads a colour token, so nothing draws a raw token past it", () => {
    const readers = Object.entries(sources)
      .filter(([, source]) => importedFrom(source, "design/tokens.ts").includes("color") || importedFrom(source, "design/tokenFile.ts").includes("resolveColor"))
      .map(([file]) => file);

    expect(readers).toEqual(["./theme.ts"]);
  });

  it("should find a token read when a module imports the token colour, so the guard can fail", () => {
    expect(importedFrom('import { color as tokenColor, sizePx } from "../design/tokens.ts";', "design/tokens.ts")).toContain("color");
    expect(importedFrom('import { sizePx } from "../design/tokens.ts";', "design/tokens.ts")).not.toContain("color");
  });

  it("should leave no colour literal in any source outside the design tokens", () => {
    const literal = Object.entries(sources)
      .map(([file, source]) => [file, colourLiterals(source)] as const)
      .filter(([, found]) => found.length > 0)
      .map(([file, found]) => `${file}: ${found.join(" ")}`);

    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(literal).toEqual([]);
  });

  it("should find a hex, an rgb() and a named colour when a source holds one, so the guard can fail", () => {
    expect(colourLiterals('ctx.fillStyle = "#ff0000"; x = "rgb(1, 2, 3)"; y = "red"; // "#00ff00"')).toEqual(['"#ff0000', "rgb(1", '"red"']);
  });
});
