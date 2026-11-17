import { describe, expect, it } from "vitest";

import {
  CHART_COLOR_GROUPS,
  CHART_COLOR_ROLES,
  floorMinimum,
  isChartColor,
  parseChartColorOverrides,
  resolveChartColor,
  roleContrast,
} from "./chartColors.ts";
import { composite, contrastRatio } from "./color.ts";
import { BOOKMAP_STAGE, GRAPHIC, SURFACES, TEXT, WARMUP_BAND_ALPHA } from "./contrastFloors.ts";
import { THEMES, parseTokenFile, resolveColor } from "./tokenFile.ts";
import { tokens } from "./tokens.ts";

// The chart-colour role registry and the override resolution every canvas and stylesheet reads.

/** The roles the maintainer's ruling makes configurable, in the registry's order. */
const CONFIGURABLE = [
  "up",
  "down",
  "dot-outline-buy",
  "dot-outline-sell",
  "bid",
  "ask",
  "bid-strong",
  "ask-strong",
  "heat-0",
  "heat-25",
  "heat-50",
  "heat-75",
  "heat-100",
  "last-price",
  "price-line",
  "vwap",
  "ema-10",
  "ema-13",
  "ema-24",
  "ema-48",
  "ema-200",
  "indicator-rsi",
  "indicator-macd",
  "indicator-macd-signal",
  "indicator-atr",
  "support",
  "resistance",
  "poc",
  "value-area",
  "node-hvn",
  "node-lvn",
  "bias-bullish",
  "bias-bearish",
  "bias-neutral",
  "event-iceberg",
  "event-stacked-imbalance",
  "event-unfinished-auction",
  "event-trapped-traders",
  "event-cvd-divergence",
  "event-delta-exhaustion",
  "event-spoof",
  "event-liquidity-sweep",
  "event-single-prints",
  "event-failed-reclaim",
  "event-unknown",
  "warmup",
];

const tokenNames = new Set(tokens.color.tokens.map((token) => token.name));

describe("CHART_COLOR_ROLES", () => {
  it("should list exactly the configurable roles of the ruling when the registry is read", () => {
    expect(CHART_COLOR_ROLES.map((role) => role.token)).toEqual(CONFIGURABLE);
  });

  it("should name a colour token, a plain-language name, its marks and at least one tab when a role is defined", () => {
    const incomplete = CHART_COLOR_ROLES.filter(
      (role) => !tokenNames.has(role.token) || role.name.trim() === "" || role.marks.trim() === "" || role.tabs.length === 0,
    ).map((role) => role.token);

    expect(incomplete).toEqual([]);
    expect(new Set(CHART_COLOR_ROLES.map((role) => role.name)).size).toBe(CHART_COLOR_ROLES.length);
  });

  it("should put every role in a declared group and leave no group empty when roles are grouped by meaning", () => {
    expect(CHART_COLOR_ROLES.filter((role) => !CHART_COLOR_GROUPS.includes(role.group)).map((role) => role.token)).toEqual([]);
    expect(CHART_COLOR_GROUPS.filter((group) => !CHART_COLOR_ROLES.some((role) => role.group === group))).toEqual([]);
  });

  it("should make no surface, text or chrome token configurable", () => {
    const chrome = /^(?:surface|on-|outline|primary|state-|scrim-|status-|error|danger|highlight-)/;

    expect(CHART_COLOR_ROLES.filter((role) => chrome.test(role.token)).map((role) => role.token)).toEqual([]);
  });

  it("should take each role's floor from NFR-8's lists: text 4.5:1, a line 3:1, and none for a fill it does not list", () => {
    const expected = (token: string) =>
      (TEXT as readonly string[]).includes(token) ? "text" : (GRAPHIC as readonly string[]).includes(token) ? "graphic" : "none";

    expect(CHART_COLOR_ROLES.filter((role) => role.floor !== expected(role.token)).map((role) => role.token)).toEqual([]);
    expect(CHART_COLOR_ROLES.find((role) => role.token === "up")?.floor).toBe("text");
    expect(CHART_COLOR_ROLES.find((role) => role.token === "vwap")?.floor).toBe("graphic");
    expect(CHART_COLOR_ROLES.find((role) => role.token === "heat-50")?.floor).toBe("none");
    expect([floorMinimum("text"), floorMinimum("graphic"), floorMinimum("none")]).toEqual([4.5, 3, 0]);
  });
});

describe("isChartColor", () => {
  it.each(["#a1b2c3", "#A1B2C3", "#000000"])("should accept %s, a six-digit hex colour", (value) => {
    expect(isChartColor(value)).toBe(true);
  });

  it.each(["#fff", "#a1b2c", "#a1b2c3d", "#a1b2cg", "a1b2c3", "red", "rgb(1, 2, 3)", "", 0x123456, null])(
    "should refuse %s, which is not a six-digit hex colour",
    (value) => {
      expect(isChartColor(value)).toBe(false);
    },
  );
});

describe("parseChartColorOverrides", () => {
  it("should keep a valid colour for a known role in each theme, lower-cased, when the stored value is read", () => {
    expect(parseChartColorOverrides({ dark: { up: "#AABBCC" }, light: { bid: "#010203" } })).toEqual({
      dark: { up: "#aabbcc" },
      light: { bid: "#010203" },
    });
  });

  it("should drop an unknown role, a token that is not configurable and a value that is not a colour when it is read", () => {
    const parsed = parseChartColorOverrides({
      dark: { up: "#112233", nonsense: "#112233", surface: "#112233", "on-surface": "#112233", down: "red", bid: "#fff", ask: 7 },
      light: { vwap: "#445566", "dot-label": "#445566" },
    });

    expect(parsed).toEqual({ dark: { up: "#112233" }, light: { vwap: "#445566" } });
  });

  it.each([null, undefined, "x", 3, [], { dark: "x", light: [] }, { dark: null }])(
    "should give no overrides for either theme when the stored value is %j",
    (raw) => {
      expect(parseChartColorOverrides(raw)).toEqual({ dark: {}, light: {} });
    },
  );

  it("should not take an inherited property as a role when it is read", () => {
    const inherited = Object.create({ up: "#123456" }) as Record<string, string>;

    expect(parseChartColorOverrides({ dark: inherited })).toEqual({ dark: {}, light: {} });
  });
});

describe("resolveChartColor", () => {
  it("should give every token's theme default in both themes when nothing is overridden", () => {
    const differing = THEMES.flatMap((theme) =>
      [...tokenNames].filter((name) => resolveChartColor(tokens, name, theme, {}) !== resolveColor(tokens, name, theme)).map((name) => `${theme} ${name}`),
    );

    expect(differing).toEqual([]);
  });

  it("should give every token its theme default when only an unrelated role is overridden", () => {
    const touched = new Set(["vwap"]);
    const differing = THEMES.flatMap((theme) =>
      [...tokenNames]
        .filter((name) => !touched.has(name) && resolveChartColor(tokens, name, theme, { vwap: "#123456" }) !== resolveColor(tokens, name, theme))
        .map((name) => `${theme} ${name}`),
    );

    expect(differing).toEqual([]);
  });

  it("should give the override, and every alias of it, when a role is overridden", () => {
    const overrides = { up: "#123456" };

    expect(resolveChartColor(tokens, "up", "dark", overrides)).toBe("#123456");
    expect(resolveChartColor(tokens, "aggressor-buy", "dark", overrides)).toBe("#123456");
    expect(resolveChartColor(tokens, "bias-bullish", "dark", overrides)).toBe("#123456");
    expect(resolveChartColor(tokens, "down", "dark", overrides)).toBe(resolveColor(tokens, "down", "dark"));
  });

  it("should give a role's own override over the one its alias points to", () => {
    expect(resolveChartColor(tokens, "bias-bullish", "light", { up: "#123456", "bias-bullish": "#654321" })).toBe("#654321");
  });

  it("should turn the live price line's halo to the opposite ink when the price line is overridden to the halo's side", () => {
    const dark = { "price-line": "#101010" };
    const light = { "price-line": "#fafafa" };

    expect(resolveChartColor(tokens, "price-line-halo", "dark", dark)).toBe(resolveColor(tokens, "price-line", "dark"));
    // The warmup stretch's halo is decorative, under warmup dashes, so it keeps its own colour.
    expect(resolveChartColor(tokens, "price-line-halo-warmup", "dark", dark)).toBe(resolveColor(tokens, "price-line-halo-warmup", "dark"));
    expect(resolveChartColor(tokens, "price-line-halo", "light", light)).toBe(resolveColor(tokens, "price-line", "light"));
  });

  it("should keep the live price line's halo when the overridden line still reads best on them", () => {
    expect(resolveChartColor(tokens, "price-line-halo", "dark", { "price-line": "#ffff00" })).toBe(resolveColor(tokens, "price-line-halo", "dark"));
  });

  it("should swap a volume dot's label and halo inks when up and down are overridden to the label's side", () => {
    const overrides = { up: "#101820", down: "#202020" };

    expect(resolveChartColor(tokens, "dot-label", "dark", overrides)).toBe(resolveColor(tokens, "dot-label-halo", "dark"));
    expect(resolveChartColor(tokens, "dot-label-halo", "dark", overrides)).toBe(resolveColor(tokens, "dot-label", "dark"));
  });

  it("should halo the volume dot outlines in whichever dot ink reads better on both chosen outlines", () => {
    const darkOutlines = { "dot-outline-buy": "#103010", "dot-outline-sell": "#301010" };
    const lightOutlines = { "dot-outline-buy": "#a0f0a0", "dot-outline-sell": "#f0a0a0" };

    expect(resolveColor(tokens, "dot-outline-halo", "dark")).toBe(resolveColor(tokens, "dot-label", "dark"));
    expect(resolveChartColor(tokens, "dot-outline-halo", "dark", darkOutlines)).toBe(resolveColor(tokens, "dot-label-halo", "dark"));
    expect(resolveChartColor(tokens, "dot-outline-halo", "light", lightOutlines)).toBe(resolveColor(tokens, "dot-label-halo", "light"));
    expect(resolveChartColor(tokens, "dot-outline-halo", "dark", { "dot-outline-buy": "#40ff40" })).toBe(resolveColor(tokens, "dot-label", "dark"));
    // The outline halo follows the outlines only: a label that swaps ink on overridden fills leaves it alone.
    expect(resolveChartColor(tokens, "dot-outline-halo", "dark", { up: "#101820", down: "#202020" })).toBe(resolveColor(tokens, "dot-label", "dark"));
  });
});

describe("roleContrast", () => {
  // Every surface and the warmup band are white, so a colour's worst contrast is its contrast on white.
  const white = parseTokenFile({
    ...tokens,
    color: {
      ...tokens.color,
      tokens: [
        ...tokens.color.tokens.filter((token) => !(SURFACES as readonly string[]).includes(token.name) && token.name !== "warmup"),
        ...SURFACES.map((name) => ({ name, value: "#ffffff", usage: "test" })),
        { name: "warmup", value: "#ffffff", usage: "test" },
      ],
    },
  });

  it.each([
    ["vwap", "#959595", true],
    ["vwap", "#949494", false],
    ["up", "#777777", true],
    ["up", "#767676", false],
  ] as const)("should warn about %s at %s only when it falls below its floor", (token, colour, below) => {
    const result = roleContrast(white, token, colour, "dark", {});

    expect(result.below).toBe(below);
    expect(result.ratio).toBeCloseTo(contrastRatio(colour, "#ffffff"), 6);
  });

  it("should never warn about a role NFR-8 gives no floor, however low its contrast", () => {
    expect(roleContrast(white, "heat-50", "#ffffff", "dark", {})).toEqual({ ratio: 1, minimum: 0, below: false });
  });

  it("should take the worst of the six surfaces and the warmup band", () => {
    const band = composite(resolveColor(tokens, "warmup", "dark"), WARMUP_BAND_ALPHA, resolveColor(tokens, BOOKMAP_STAGE, "dark"));
    const grounds = [...SURFACES.map((name) => resolveColor(tokens, name, "dark")), band];

    expect(roleContrast(tokens, "vwap", "#808080", "dark", {}).ratio).toBeCloseTo(Math.min(...grounds.map((ground) => contrastRatio("#808080", ground))), 9);
  });

  it("should measure on the band of the overridden warmup when warmup itself is overridden", () => {
    const plain = roleContrast(tokens, "warmup", "#686e79", "dark", {}).ratio;
    const bright = roleContrast(tokens, "warmup", "#ffffff", "dark", { warmup: "#ffffff" }).ratio;

    // White warmup's band is a light grey, so white on it is far below its contrast on the dark surfaces.
    expect(bright).toBeLessThan(contrastRatio("#ffffff", resolveColor(tokens, "surface-highest", "dark")));
    expect(plain).toBeGreaterThanOrEqual(3);
  });

  it("should hold every role's theme default to its floor in both themes, so a default never warns", () => {
    const warned = THEMES.flatMap((theme) =>
      CHART_COLOR_ROLES.filter((role) => roleContrast(tokens, role.token, resolveColor(tokens, role.token, theme), theme, {}).below).map(
        (role) => `${theme} ${role.token}`,
      ),
    );

    expect(warned).toEqual([]);
  });
});
