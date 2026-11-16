// Colour arithmetic on the design tokens' six-digit hex values.

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** The red, green and blue channels of a six-digit hex colour, 0–255. */
export function rgbChannels(hex: string): readonly [number, number, number] {
  const match = HEX.exec(hex);
  if (!match) {
    throw new Error(`Expected a six-digit hex colour, got "${hex}"`);
  }
  return [parseInt(match[1] ?? "", 16), parseInt(match[2] ?? "", 16), parseInt(match[3] ?? "", 16)];
}

function linearChannels(hex: string): readonly [number, number, number] {
  return rgbChannels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = linearChannels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** CIELAB L*, a*, b* (D65) of a six-digit hex colour: L* 0–100, a* and b* 0 for a neutral grey. */
export function cieLab(hex: string): readonly [number, number, number] {
  const [r, g, b] = linearChannels(hex);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference (ΔE*ab) between two six-digit hex colours; about 2.3 is just noticeable. */
export function deltaE(first: string, second: string): number {
  const [l1, a1, b1] = cieLab(first);
  const [l2, a2, b2] = cieLab(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** WCAG 2 contrast ratio between two six-digit hex colours, from 1 to 21; the order does not matter. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The six-digit hex colour seen where `colour` is painted at `alpha` over an opaque `ground`. */
export function composite(colour: string, alpha: number, ground: string): string {
  const top = rgbChannels(colour);
  const under = rgbChannels(ground);
  return `#${top.map((channel, i) => Math.round(channel * alpha + (under[i] ?? 0) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * `preferred` when it holds `minimum` contrast on `background`; otherwise whichever of `preferred` and `others` has
 * the highest contrast there.
 */
export function mostReadable(background: string, preferred: string, others: readonly string[], minimum: number): string {
  if (contrastRatio(preferred, background) >= minimum) return preferred;
  return [preferred, ...others].reduce((best, candidate) =>
    contrastRatio(candidate, background) > contrastRatio(best, background) ? candidate : best,
  );
}

/** "r, g, b" for a six-digit hex colour, for canvas `rgba(${triplet}, alpha)` strings. */
export function rgbTriplet(hex: string): string {
  return rgbChannels(hex).join(", ");
}

const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i;

/**
 * `rgba(r, g, b, alpha)` from a token's channels: a six-digit hex or an rgb()/rgba() value, whose own alpha is
 * replaced. The alpha is rounded to three places.
 */
export function withAlpha(colour: string, alpha: number): string {
  const rgb = RGB.exec(colour);
  const triplet = rgb ? `${rgb[1]}, ${rgb[2]}, ${rgb[3]}` : HEX.test(colour) ? rgbTriplet(colour) : null;
  if (triplet === null) {
    throw new Error(`Expected a hex or rgb() colour, got "${colour}"`);
  }
  return `rgba(${triplet}, ${Math.round(alpha * 1000) / 1000})`;
}
