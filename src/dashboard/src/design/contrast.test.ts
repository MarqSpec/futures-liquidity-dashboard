import { describe, expect, it } from "vitest";

import { BOOKMAP_STAGE, WARMUP_BAND_ALPHA } from "../components/drawBookmap.ts";
import { CELL_TEXT_TOKENS, FOOTPRINT_GROUND, splitCellAlpha } from "../components/drawFootprint.ts";
import { composite, contrastRatio, deltaE, mostReadable } from "./color.ts";
import { GRAPHIC, GRAPHIC_MINIMUM, SURFACES, TEXT, TEXT_MINIMUM } from "./contrastFloors.ts";
import { THEMES, type ThemeId, type TokenFile, parseTokenFile, resolveColor } from "./tokenFile.ts";
import { tokens } from "./tokens.ts";

// reference: REQUIREMENTS.md NFR-8 (accessibility); the thresholds are WCAG 2.2 SC 1.4.3 and SC 1.4.11.

// The text and graphic lists, the surfaces and the two floors live in contrastFloors.ts, which the chart-colour
// registry reads too.

/** Text on its own fill: 4.5:1. */
const PAIRS: readonly (readonly [text: string, fill: string])[] = [
  ["on-primary", "primary"],
  ["on-primary-container", "primary-container"],
  ["on-status-live", "status-live"],
  ["on-status-replay", "status-replay"],
  ["on-status-simulated", "status-simulated"],
  ["on-status-degraded", "status-degraded"],
  ["on-status-bad", "status-bad"],
  ["on-price-tag", "price-tag"],
  ["guide-text", "guide-fill"],
  ["guide-caption", "guide-fill"],
  // A large dot's quantity straddles both segments, so it must hold on each; no exception.
  ["dot-label", "aggressor-buy"],
  ["dot-label", "aggressor-sell"],
  // A five-glyph quantity (1,000 and up) is wider than its dot: it is stroked in its halo, so every glyph reads on
  // the halo, and the halo reads on the stage the label overflows onto, empty or with no depth.
  ["dot-label", "dot-label-halo"],
  ["dot-label-halo", "surface-lowest"],
  ["dot-label-halo", "heat-0"],
];

function ratio(foreground: string, background: string, theme: ThemeId, file: TokenFile = tokens): number {
  return contrastRatio(resolveColor(file, foreground, theme), resolveColor(file, background, theme));
}

/** Every pairing below `minimum`, as "theme name/surface ratio:1". */
function shortfalls(names: readonly string[], minimum: number, file: TokenFile = tokens): string[] {
  return THEMES.flatMap((theme) =>
    names.flatMap((name) =>
      SURFACES.map((surface) => ({ surface, value: ratio(name, surface, theme, file) }))
        .filter(({ value }) => value < minimum)
        .map(({ surface, value }) => `${theme} ${name}/${surface} ${value.toFixed(2)}:1`),
    ),
  );
}

describe("design tokens contrast", () => {
  it("should hold 4.5:1 on all six surfaces in both themes when the token is text", () => {
    expect(shortfalls(TEXT, TEXT_MINIMUM)).toEqual([]);
  });

  it("should hold 3:1 on all six surfaces in both themes when the token is a line or meaningful border", () => {
    expect(shortfalls(GRAPHIC, GRAPHIC_MINIMUM)).toEqual([]);
  });

  it("should hold 3:1 on all six Light surfaces when the token is an Order Flow event marker", () => {
    // The Light half has no exception: this is the floor the Light theme adds for the event palette.
    const events = GRAPHIC.filter((name) => name.startsWith("event-"));

    expect(events).toHaveLength(11);
    expect(shortfalls(events, GRAPHIC_MINIMUM).filter((line) => line.startsWith("light "))).toEqual([]);
  });

  it("should hold 4.5:1 in both themes when text is set on its own fill", () => {
    const failing = THEMES.flatMap((theme) =>
      PAIRS.map(([text, fill]) => ({ key: `${theme} ${text}/${fill}`, value: ratio(text, fill, theme) }))
        .filter(({ value }) => value < TEXT_MINIMUM)
        .map(({ key, value }) => `${key} ${value.toFixed(2)}:1`),
    );

    expect(failing).toEqual([]);
  });

  it("should leave footprint cell text 4.5:1 on every up and down shade in both themes when a column is split", () => {
    // The text picks the most readable of CELL_TEXT_TOKENS over each cell's shade; a grey down at 85% left the
    // default text at 1.9:1 in Terminal.
    const shades = [...Array.from({ length: 101 }, (_, step) => splitCellAlpha(step, 100, false)), splitCellAlpha(0, 100, true)];
    const failing = THEMES.flatMap((theme) =>
      (["up", "down"] as const).flatMap((side) =>
        shades
          .map((alpha) => {
            const fill = composite(resolveColor(tokens, side, theme), alpha, resolveColor(tokens, FOOTPRINT_GROUND, theme));
            const [preferred = "", ...others] = CELL_TEXT_TOKENS.map((name) => resolveColor(tokens, name, theme));
            return { alpha, value: contrastRatio(mostReadable(fill, preferred, others, TEXT_MINIMUM), fill) };
          })
          .filter(({ value }) => value < TEXT_MINIMUM)
          .map(({ alpha, value }) => `${theme} ${side} at ${alpha.toFixed(2)} ${value.toFixed(2)}:1`),
      ),
    );

    expect(shades).toHaveLength(102);
    expect(failing).toEqual([]);
  });

  it("should hold every text token to 4.5:1 and every line to 3:1 on the Order Flow warmup band in both themes", () => {
    // The warmup candles, the dashed price step, the watermark edge, the no-L2 caption and every guide drawn across
    // the warmup side sit on the band composited over the stage, a ground none of the six surfaces stands for, so the
    // band is held like a seventh surface: to the whole text and graphic lists, not only the marks drawn there today.
    const floors = [
      ...TEXT.map((name) => ({ name, minimum: TEXT_MINIMUM })),
      ...GRAPHIC.map((name) => ({ name, minimum: GRAPHIC_MINIMUM })),
    ];
    const failing = THEMES.flatMap((theme) => {
      const band = composite(resolveColor(tokens, "warmup", theme), WARMUP_BAND_ALPHA, resolveColor(tokens, BOOKMAP_STAGE, theme));
      return floors
        .map(({ name, minimum }) => ({ name, minimum, value: contrastRatio(resolveColor(tokens, name, theme), band) }))
        .filter(({ value, minimum }) => value < minimum)
        .map(({ name, value }) => `${theme} ${name}/warmup band ${value.toFixed(2)}:1`);
    });

    expect(floors.map(({ name }) => name)).toContain("warmup");
    expect(floors.map(({ name }) => name)).toContain("on-surface-muted");
    expect(failing).toEqual([]);
  });

  it("should report a pairing just under each minimum when the checker is given one", () => {
    // Self-test of the checker: #777777 on white is 4.48:1, #959595 on white is 2.995:1. Both sit just under,
    // on every one of the six surfaces in both themes: 12 shortfalls each.
    const surfaces = Object.fromEntries(SURFACES.map((surface) => [surface, "#ffffff"]));
    const boundary = parseTokenFile({
      ...tokens,
      color: {
        ...tokens.color,
        tokens: [
          ...Object.entries(surfaces).map(([name, value]) => ({ name, value, usage: "test" })),
          { name: "grey-text", value: "#777777", usage: "test" },
          { name: "grey-line", value: "#959595", usage: "test" },
        ],
      },
    });

    expect(shortfalls(["grey-text"], TEXT_MINIMUM, boundary)).toHaveLength(12);
    expect(shortfalls(["grey-line"], GRAPHIC_MINIMUM, boundary)).toHaveLength(12);
  });
});

// A volume dot's edge is outlined by aggressor side, green for buying and red for selling: a line, so 3:1 on
// every ground a dot sits on, and over the brighter heat stops the outline or the thin halo outside it carries 3:1.
const OUTLINES = ["dot-outline-buy", "dot-outline-sell"] as const;
const OUTLINE_HALO = "dot-outline-halo";
const BRIGHTER_HEAT = ["heat-25", "heat-50", "heat-75", "heat-100"] as const;
/** The marks a volume dot is drawn beside: the book's sides, the dot's own fills and every Order Flow event marker. */
const BESIDE_DOTS = ["bid", "ask", "up", "down", ...GRAPHIC.filter((name) => name.startsWith("event-"))];
/** ΔE*ab (CIE76) a dot outline keeps from every mark it is drawn beside; about 2.3 is just noticeable. */
const DISTINCT = 10;

describe("volume dot outlines", () => {
  it("should hold 3:1 on the six surfaces, heat-0 and the warmup band in both themes when a volume dot is outlined", () => {
    const failing = THEMES.flatMap((theme) => {
      const band = composite(resolveColor(tokens, "warmup", theme), WARMUP_BAND_ALPHA, resolveColor(tokens, BOOKMAP_STAGE, theme));
      const grounds = [...[...SURFACES, "heat-0"].map((name) => [name, resolveColor(tokens, name, theme)] as const), ["warmup band", band] as const];
      return OUTLINES.flatMap((name) =>
        grounds
          .map(([ground, hex]) => ({ key: `${theme} ${name}/${ground}`, value: contrastRatio(resolveColor(tokens, name, theme), hex) }))
          .filter(({ value }) => value < GRAPHIC_MINIMUM)
          .map(({ key, value }) => `${key} ${value.toFixed(2)}:1`),
      );
    });

    // In the graphic list, so the chart-colour panel holds a viewer's outline colour to the line floor too.
    expect(OUTLINES.filter((name) => !(GRAPHIC as readonly string[]).includes(name))).toEqual([]);
    expect(failing).toEqual([]);
  });

  it("should read on its halo, and keep the outline or its halo at 3:1 on every brighter heat stop, in both themes", () => {
    const failing = THEMES.flatMap((theme) => {
      const halo = resolveColor(tokens, OUTLINE_HALO, theme);
      return OUTLINES.flatMap((name) => {
        const outline = resolveColor(tokens, name, theme);
        const onHalo = contrastRatio(outline, halo) < GRAPHIC_MINIMUM ? [`${theme} ${name}/${OUTLINE_HALO} ${contrastRatio(outline, halo).toFixed(2)}:1`] : [];
        const onHeat = BRIGHTER_HEAT.map((stop) => {
          const heat = resolveColor(tokens, stop, theme);
          return { stop, value: Math.max(contrastRatio(outline, heat), contrastRatio(halo, heat)) };
        })
          .filter(({ value }) => value < GRAPHIC_MINIMUM)
          .map(({ stop, value }) => `${theme} ${name} or its halo/${stop} ${value.toFixed(2)}:1`);
        return [...onHalo, ...onHeat];
      });
    });

    expect(failing).toEqual([]);
  });

  it("should keep each outline distinct from the book, the dot fills, the event markers and the other outline in both themes", () => {
    const close = THEMES.flatMap((theme) =>
      OUTLINES.flatMap((name) =>
        [...BESIDE_DOTS, ...OUTLINES.filter((other) => other !== name)]
          .map((other) => ({ other, value: deltaE(resolveColor(tokens, name, theme), resolveColor(tokens, other, theme)) }))
          .filter(({ value }) => value < DISTINCT)
          .map(({ other, value }) => `${theme} ${name}/${other} ΔE ${value.toFixed(1)}`),
      ),
    );

    expect(BESIDE_DOTS).toHaveLength(15);
    expect(close).toEqual([]);
  });
});
