import { describe, expect, it } from "vitest";

import { parseTokenFile } from "./tokenFile.ts";
import tokenJson from "./tokens.json";
import committedCss from "./tokens.css?raw";
import { renderTokensCss } from "./tokensCss.ts";

const synthetic = parseTokenFile({
  name: "Synthetic",
  version: 1,
  color: {
    themes: [
      { id: "dark", name: "Terminal" },
      { id: "light", name: "Light" },
    ],
    tokens: [
      { name: "down", value: { dark: "#ef5350", light: "#b71c1c" }, usage: "test" },
      { name: "resistance", value: "{down}", usage: "test" },
      { name: "price-tag", value: "#f5d76e", usage: "test" },
    ],
  },
  type: { fonts: [], families: { sans: '"Plex", sans-serif', mono: "monospace" }, groups: [] },
  spacing: { tokens: [{ name: "space-4", value: "4px", usage: "test" }] },
  radius: { tokens: [{ name: "radius-sm", value: "4px", usage: "test" }] },
  shadow: { tokens: [{ name: "elevation-1", value: { dark: "0 1px 2px #000000", light: "0 1px 2px #888888" }, usage: "test" }] },
  size: { tokens: [{ name: "ladder-row", value: "16px", usage: "test" }] },
  opacity: { tokens: [{ name: "opacity-disabled", value: "0.38", usage: "test" }] },
  zIndex: { tokens: [{ name: "z-banner", value: "40", usage: "test" }] },
});

/** The declarations inside the first rule whose selector is exactly `selector`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) {
    return "";
  }
  return css.slice(start, css.indexOf("}", start));
}

const darkSelector = ':root,\n[data-theme="dark"]';
const lightSelector = '[data-theme="light"]';

describe("renderTokensCss", () => {
  it("should declare every colour and shadow at its Terminal value when the theme is dark", () => {
    const dark = block(renderTokensCss(synthetic), darkSelector);

    expect(dark).toContain("--down: #ef5350;");
    expect(dark).toContain("--price-tag: #f5d76e;");
    expect(dark).toContain("--elevation-1: 0 1px 2px #000000;");
  });

  it("should declare the Light value when the token has one", () => {
    const light = block(renderTokensCss(synthetic), lightSelector);

    expect(light).toContain("--down: #b71c1c;");
    expect(light).toContain("--elevation-1: 0 1px 2px #888888;");
  });

  it("should not repeat a token in the Light block when it has no Light value", () => {
    expect(block(renderTokensCss(synthetic), lightSelector)).not.toContain("--price-tag");
  });

  it("should re-declare an alias as a var() in both blocks when its value is a reference", () => {
    const css = renderTokensCss(synthetic);

    expect(block(css, darkSelector)).toContain("--resistance: var(--down);");
    expect(block(css, lightSelector)).toContain("--resistance: var(--down);");
  });

  it("should declare the theme-independent scales and font stacks under :root when they are tokens", () => {
    const root = block(renderTokensCss(synthetic), "\n:root");

    expect(root).toContain('--font-sans: "Plex", sans-serif;');
    expect(root).toContain("--font-mono: monospace;");
    expect(root).toContain("--space-4: 4px;");
    expect(root).toContain("--radius-sm: 4px;");
    expect(root).toContain("--ladder-row: 16px;");
    expect(root).toContain("--opacity-disabled: 0.38;");
    expect(root).toContain("--z-banner: 40;");
  });
});

describe("tokens.css", () => {
  it("should be exactly what tokens.json renders to when the two are committed together", () => {
    // A token changed in tokens.json and not regenerated into tokens.css fails here: run `pnpm run tokens`.
    expect(committedCss.replace(/\r\n/g, "\n")).toBe(renderTokensCss(parseTokenFile(tokenJson)));
  });
});
