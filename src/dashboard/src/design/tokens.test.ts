import { describe, expect, it } from "vitest";

import { cieLab } from "./color.ts";
import { color, fontFamilies, sizePx, typeStyle } from "./tokens.ts";

describe("tokens", () => {
  it("should give the Terminal value when no theme is named", () => {
    expect(color("surface")).toBe("#0b0e14");
    expect(color("surface", "light")).toBe("#e7e6df");
  });

  it("should give a size token in pixels when it is a px value", () => {
    expect(sizePx("ladder-row")).toBe(16);
  });

  it("should throw when the size token does not exist", () => {
    expect(() => sizePx("no-such-size")).toThrow(/no-such-size/);
  });

  it("should give a type role's size, line height and weight when the role exists", () => {
    expect(typeStyle("data-sm")).toMatchObject({ fontSize: "11px", lineHeight: "16px", fontWeight: 400 });
    expect(typeStyle("data-xs")).toMatchObject({ fontSize: "10px", lineHeight: "13px", fontWeight: 400 });
  });

  it("should throw when the type role does not exist", () => {
    expect(() => typeStyle("data-xxl")).toThrow(/data-xxl/);
  });

  it("should put the bundled IBM Plex family first when the stacks are read", () => {
    expect(fontFamilies.sans.startsWith('"IBM Plex Sans",')).toBe(true);
    expect(fontFamilies.mono.startsWith('"IBM Plex Mono",')).toBe(true);
  });
});

// The Light ground is warm paper, not white, and the heatmap's empty ground is the same colour (maintainer, 2026-11-15).
describe("Light ground", () => {
  it("should give heat-0 the Light chart ground when the heatmap has no resting quantity", () => {
    expect(color("heat-0", "light")).toBe(color("surface-lowest", "light"));
  });

  it("should ground Light in a subdued warm paper, not white, when the Light theme draws", () => {
    // White is L* 100 with no tint; a warm paper sits clearly below it and leans yellow (CIELAB b* above 1).
    const offWhite = (["surface-lowest", "heat-0"] as const)
      .map((name) => ({ name, value: color(name, "light") }))
      .filter(({ value }) => {
        const [lightness = 100, , warmth = 0] = cieLab(value);
        return lightness > 96 || warmth <= 1;
      })
      .map(({ name, value }) => `${name} ${value}`);

    expect(offWhite).toEqual([]);
  });
});
