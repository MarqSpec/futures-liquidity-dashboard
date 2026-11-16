import { describe, expect, it } from "vitest";

import { parseTokenFile, resolveColor } from "./tokenFile.ts";

function file(tokens: readonly { name: string; value: string | { dark: string; light: string } }[]) {
  return parseTokenFile({
    name: "Synthetic",
    version: 1,
    color: {
      themes: [
        { id: "dark", name: "Terminal" },
        { id: "light", name: "Light" },
      ],
      tokens: tokens.map((token) => ({ ...token, usage: "test" })),
    },
    type: { fonts: [], families: { sans: "sans-serif", mono: "monospace" }, groups: [] },
    spacing: { tokens: [] },
    radius: { tokens: [] },
    shadow: { tokens: [] },
    size: { tokens: [] },
    opacity: { tokens: [] },
    zIndex: { tokens: [] },
  });
}

describe("resolveColor", () => {
  it("should give the theme's value when the token has one per theme", () => {
    const tokens = file([{ name: "down", value: { dark: "#ef5350", light: "#b71c1c" } }]);

    expect(resolveColor(tokens, "down", "dark")).toBe("#ef5350");
    expect(resolveColor(tokens, "down", "light")).toBe("#b71c1c");
  });

  it("should give the same value in both themes when the token has a single value", () => {
    const tokens = file([{ name: "price-tag", value: "#f5d76e" }]);

    expect(resolveColor(tokens, "price-tag", "dark")).toBe("#f5d76e");
    expect(resolveColor(tokens, "price-tag", "light")).toBe("#f5d76e");
  });

  it("should follow an alias to the theme's value of its target when the value is a reference", () => {
    const tokens = file([
      { name: "down", value: { dark: "#ef5350", light: "#b71c1c" } },
      { name: "resistance", value: "{down}" },
    ]);

    expect(resolveColor(tokens, "resistance", "dark")).toBe("#ef5350");
    expect(resolveColor(tokens, "resistance", "light")).toBe("#b71c1c");
  });

  it("should throw when the name is not a token", () => {
    const tokens = file([{ name: "down", value: "#ef5350" }]);

    expect(() => resolveColor(tokens, "missing", "dark")).toThrow(/missing/);
  });

  it("should throw when an alias points at a token that does not exist", () => {
    const tokens = file([{ name: "resistance", value: "{nowhere}" }]);

    expect(() => resolveColor(tokens, "resistance", "dark")).toThrow(/nowhere/);
  });

  it("should throw when aliases form a cycle", () => {
    const tokens = file([
      { name: "a", value: "{b}" },
      { name: "b", value: "{a}" },
    ]);

    expect(() => resolveColor(tokens, "a", "dark")).toThrow(/cycle/);
  });
});

describe("parseTokenFile", () => {
  it("should throw when a colour token has no value", () => {
    expect(() =>
      parseTokenFile({ name: "Synthetic", version: 1, color: { themes: [], tokens: [{ name: "x", usage: "test" }] } }),
    ).toThrow();
  });
});
