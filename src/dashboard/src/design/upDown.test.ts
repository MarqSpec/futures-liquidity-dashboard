import { describe, expect, it } from "vitest";

import { cieLab, deltaE } from "./color.ts";
import { THEMES, resolveColor } from "./tokenFile.ts";
import { tokens } from "./tokens.ts";

// Price up is a blue and price down a grey, in both themes; warnings keep the red down had (maintainer, 2026-11-15).
// The contrast floors for up, down and danger are in contrast.test.ts.

/** CIELAB hue angle in degrees, 0–360. */
function hue(hex: string): number {
  const [, a, b] = cieLab(hex);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

function chroma(hex: string): number {
  const [, a, b] = cieLab(hex);
  return Math.hypot(a, b);
}

/** Every colour token whose value in `theme` is the same colour as `target`'s. */
function sharing(target: string, theme: (typeof THEMES)[number]): string[] {
  const value = resolveColor(tokens, target, theme);
  return tokens.color.tokens.map((token) => token.name).filter((name) => resolveColor(tokens, name, theme) === value);
}

describe("up and down tokens", () => {
  it("should make up a saturated blue in both themes when price rises", () => {
    // CIELAB hue 270°–310° is blue, the old teal up sat at 185°. Terminal's bid is 251° but Light's is 277°, so hue
    // alone does not keep up apart from bid: the ΔE test below does.
    const off = THEMES.map((theme) => ({ theme, value: resolveColor(tokens, "up", theme) }))
      .filter(({ value }) => hue(value) < 270 || hue(value) > 310 || chroma(value) < 40)
      .map(({ theme, value }) => `${theme} ${value} hue ${hue(value).toFixed(0)} chroma ${chroma(value).toFixed(0)}`);

    expect(off).toEqual([]);
  });

  it("should make down a neutral grey in both themes, and a light one in Terminal, when price falls", () => {
    const off = THEMES.map((theme) => ({ theme, value: resolveColor(tokens, "down", theme) }))
      .filter(({ theme, value }) => chroma(value) > 2 || (theme === "dark" && (cieLab(value)[0] ?? 0) < 65))
      .map(({ theme, value }) => `${theme} ${value} L* ${(cieLab(value)[0] ?? 0).toFixed(0)} chroma ${chroma(value).toFixed(1)}`);

    expect(off).toEqual([]);
  });

  it("should keep up at least ΔE 40 from bid in both themes when the two are drawn together", () => {
    // The Order Flow canvas, the ladder and the footprint draw bid beside up-coloured volume.
    const close = THEMES.map((theme) => ({ theme, distance: deltaE(resolveColor(tokens, "up", theme), resolveColor(tokens, "bid", theme)) }))
      .filter(({ distance }) => distance < 40)
      .map(({ theme, distance }) => `${theme} ΔE ${distance.toFixed(1)}`);

    expect(close).toEqual([]);
  });

  it("should give warnings the red down had through danger when a warning is shown", () => {
    // Light danger darkened from #b71c1c to hold 4.5:1 on the warm-paper ground; still the red, not grey.
    expect(THEMES.map((theme) => resolveColor(tokens, "danger", theme))).toEqual(["#ef5350", "#ac1a1a"]);
  });

  it("should leave only price-direction tokens on the up and down colours when a token shares one", () => {
    // Resistance, depth pulled and warnings once aliased {down}; they keep their red and must not follow it to grey.
    for (const theme of THEMES) {
      expect(sharing("up", theme), `${theme} up`).toEqual(["up", "aggressor-buy", "bias-bullish"]);
      expect(sharing("down", theme), `${theme} down`).toEqual(["down", "aggressor-sell", "bias-bearish"]);
    }
  });
});
