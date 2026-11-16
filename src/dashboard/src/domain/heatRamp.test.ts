import { afterEach, describe, expect, it } from "vitest";

import { rgbChannels } from "../design/color.ts";
import { color } from "../design/tokens.ts";
import { canvasTheme } from "../theme.ts";
import { autoContrastDomain, bookmapRgb, rampT } from "./heatRamp.ts";

describe("bookmapRgb in Light", () => {
  afterEach(() => canvasTheme.set("dark"));

  it("should start at warm paper, the chart ground, when the Light theme draws", () => {
    canvasTheme.set("light");

    expect(bookmapRgb(0)).toEqual([239, 237, 231]);
    expect(bookmapRgb(0)).toEqual(rgbChannels(color("surface-lowest", "light")));
  });

  it("should start at black again when the theme returns to Terminal", () => {
    canvasTheme.set("light");
    bookmapRgb(0);
    canvasTheme.set("dark");

    expect(bookmapRgb(0)).toEqual([0, 0, 0]);
  });
});

describe("bookmapRgb", () => {
  it("should walk black then blue then yellow then orange then red when t goes from 0 to 1", () => {
    expect(bookmapRgb(0)).toEqual([0, 0, 0]);
    expect(bookmapRgb(0.25)[2]).toBeGreaterThan(bookmapRgb(0.25)[0]);
    expect(bookmapRgb(0.5)[0]).toBeGreaterThan(200);
    expect(bookmapRgb(0.5)[1]).toBeGreaterThan(180);
    expect(bookmapRgb(0.75)[0]).toBeGreaterThan(bookmapRgb(0.75)[2]);
    expect(bookmapRgb(1)[0]).toBeGreaterThan(bookmapRgb(1)[1]);
  });
});

describe("autoContrastDomain", () => {
  it("should leave the source quantities unchanged when the percentiles are applied", () => {
    const values = [1, 5, 9, 40, 100];
    const before = [...values];

    const domain = autoContrastDomain(values, 0, 100);

    expect(values).toEqual(before);
    expect(domain).toEqual({ low: 1, high: 100 });
    expect(rampT(100, domain.low, domain.high)).toBe(1);
    expect(rampT(1, domain.low, domain.high)).toBe(0);
  });

  it("should clip the outer percentiles when the window has an outlier", () => {
    const domain = autoContrastDomain([10, 20, 30, 40, 100], 0, 50);

    expect(domain.high).toBe(30);
    expect(rampT(100, domain.low, domain.high)).toBe(1);
    expect(rampT(10, domain.low, domain.high)).toBe(0);
  });
});
