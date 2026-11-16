import { describe, expect, it } from "vitest";

import { cieLab, composite, contrastRatio, deltaE, mostReadable, rgbTriplet, withAlpha } from "./color.ts";

describe("contrastRatio", () => {
  it("should be 21 when the colours are black and white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("should be 1 when both colours are the same", () => {
    expect(contrastRatio("#5c9cff", "#5c9cff")).toBeCloseTo(1, 5);
  });

  it("should not depend on the order of the colours when they are swapped", () => {
    expect(contrastRatio("#0b0e14", "#8b95a7")).toBeCloseTo(contrastRatio("#8b95a7", "#0b0e14"), 10);
  });

  it("should match the WCAG 2 formula when a mid-grey is set on white", () => {
    // #767676 on white is the well-known 4.54:1 boundary grey.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("should throw when a colour is not six-digit hex", () => {
    expect(() => contrastRatio("rgba(0, 0, 0, 0.5)", "#ffffff")).toThrow(/hex/);
    expect(() => contrastRatio("#fff", "#ffffff")).toThrow(/hex/);
  });
});

describe("rgbTriplet", () => {
  it("should give the comma-separated channels when the colour is six-digit hex", () => {
    expect(rgbTriplet("#29b6f6")).toBe("41, 182, 246");
  });

  it("should throw when the colour is not six-digit hex", () => {
    expect(() => rgbTriplet("{down}")).toThrow(/hex/);
  });
});

describe("withAlpha", () => {
  it("should keep the token's channels and set the alpha when the colour is six-digit hex", () => {
    expect(withAlpha("#26a69a", 0.6)).toBe("rgba(38, 166, 154, 0.6)");
  });

  it("should replace the alpha and keep the channels when the colour is already rgba", () => {
    expect(withAlpha("rgba(144, 164, 174, 0.18)", 0.45)).toBe("rgba(144, 164, 174, 0.45)");
  });

  it("should round the alpha to three places when it is computed", () => {
    expect(withAlpha("#ef5350", 0.08 + 0.4 / 3)).toBe("rgba(239, 83, 80, 0.213)");
  });

  it("should throw when the colour is neither hex nor rgb", () => {
    expect(() => withAlpha("{down}", 0.5)).toThrow(/colour/);
  });
});

describe("cieLab", () => {
  it("should give L* 100 and no chroma when the colour is white", () => {
    const [l, a, b] = cieLab("#ffffff");
    expect(l).toBeCloseTo(100, 1);
    expect(a).toBeCloseTo(0, 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("should give the CIE D65 values when the colour is pure sRGB blue", () => {
    // sRGB #0000ff is L* 32.30, a* 79.19, b* -107.86 under D65.
    const [l, a, b] = cieLab("#0000ff");
    expect(l).toBeCloseTo(32.3, 1);
    expect(a).toBeCloseTo(79.19, 1);
    expect(b).toBeCloseTo(-107.86, 1);
  });

  it("should give no chroma when the colour is a neutral grey", () => {
    const [, a, b] = cieLab("#777777");
    expect(Math.hypot(a, b)).toBeLessThan(0.01);
  });

  it("should throw when a colour is not six-digit hex", () => {
    expect(() => cieLab("{up}")).toThrow(/hex/);
  });
});

describe("deltaE", () => {
  it("should be 100 when the colours are black and white", () => {
    expect(deltaE("#000000", "#ffffff")).toBeCloseTo(100, 1);
  });

  it("should be 0 when both colours are the same", () => {
    expect(deltaE("#29b6f6", "#29b6f6")).toBe(0);
  });

  it("should combine L*, a* and b* when the colours differ in all three", () => {
    // Pure blue against black: the square root of 32.30² + 79.19² + 107.86².
    expect(deltaE("#0000ff", "#000000")).toBeCloseTo(137.65, 1);
  });

  it("should not depend on the order of the colours when they are swapped", () => {
    expect(deltaE("#29b6f6", "#2f45e0")).toBeCloseTo(deltaE("#2f45e0", "#29b6f6"), 10);
  });
});

describe("composite", () => {
  it("should mix the colour over the ground by alpha when it is drawn translucent", () => {
    expect(composite("#ffffff", 0.5, "#000000")).toBe("#808080");
    expect(composite("#b0b0b0", 0.85, "#0b0e14")).toBe("#979899");
  });

  it("should give the colour at alpha 1 and the ground at alpha 0", () => {
    expect(composite("#6f84ff", 1, "#0b0e14")).toBe("#6f84ff");
    expect(composite("#6f84ff", 0, "#0b0e14")).toBe("#0b0e14");
  });
});

describe("mostReadable", () => {
  it("should keep the preferred colour when it reaches the minimum", () => {
    // #767676 on white is 4.54:1.
    expect(mostReadable("#ffffff", "#767676", ["#000000"], 4.5)).toBe("#767676");
  });

  it("should take the highest-contrast candidate when the preferred colour falls short", () => {
    // #777777 on white is 4.48:1.
    expect(mostReadable("#ffffff", "#777777", ["#cccccc", "#000000"], 4.5)).toBe("#000000");
  });

  it("should still give the highest-contrast candidate when none reaches the minimum", () => {
    expect(mostReadable("#808080", "#999999", ["#707070", "#a0a0a0"], 4.5)).toBe("#a0a0a0");
  });
});
