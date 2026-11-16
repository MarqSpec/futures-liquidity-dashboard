import { describe, expect, it } from "vitest";

import tokensCss from "./design/tokens.css?raw";
import css from "./index.css?raw";

// index.css styles on the design tokens only: every colour comes from tokens.css, so a theme can swap them all.

const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

function declared(source: string): Set<string> {
  return new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1] ?? ""));
}

describe("index.css", () => {
  it("should declare no custom properties of its own when the tokens live in tokens.css", () => {
    // The pre-token names (--bg, --panel, --text, --muted, --accent…) were declared here.
    expect([...declared(withoutComments)]).toEqual([]);
  });

  it("should read only custom properties that tokens.css declares when it uses var()", () => {
    const known = declared(tokensCss);
    const used = [...withoutComments.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1] ?? "");

    expect([...new Set(used.filter((name) => !known.has(name)))]).toEqual([]);
  });

  it("should give no colour as a literal when a rule sets one", () => {
    const literals = withoutComments.match(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/gi) ?? [];

    expect(literals).toEqual([]);
  });

  it("should colour the server-URL warning from danger, not down, when it warns", () => {
    // Down is a grey; a warning keeps its red through its own token.
    const rule = /\.server-url-warning\s*\{([^}]*)\}/.exec(withoutComments)?.[1] ?? "";

    expect(rule.replace(/\s+/g, " ").trim()).toBe("color: var(--danger);");
  });

  it("should give no fallback inside var() when a token is read", () => {
    // A fallback is a second, untracked copy of the colour.
    expect(withoutComments.match(/var\(\s*--[a-z0-9-]+\s*,/gi) ?? []).toEqual([]);
  });
});
