// The design system's tokens as the app reads them: tokens.json, validated once at load.

import { parseTokenFile, resolveColor, type ThemeId, type TokenFile, type TypeStyle } from "./tokenFile.ts";
import tokenJson from "./tokens.json";

export const tokens: TokenFile = parseTokenFile(tokenJson);

/** A colour token's value in `theme` (Terminal by default). */
export function color(name: string, theme: ThemeId = "dark"): string {
  return resolveColor(tokens, name, theme);
}

/** A size token in pixels, e.g. `axis-width` → 68. */
export function sizePx(name: string): number {
  const token = tokens.size.tokens.find((candidate) => candidate.name === name);
  const match = token ? /^(\d+(?:\.\d+)?)px$/.exec(token.value) : null;
  if (!match) {
    throw new Error(`No pixel size token named "${name}"`);
  }
  return Number(match[1]);
}

/** A type role (`data-sm`, `body-md`…): its size, line height and weight. */
export function typeStyle(name: string): TypeStyle {
  const style = tokens.type.groups.flatMap((group) => group.styles).find((candidate) => candidate.name === name);
  if (!style) {
    throw new Error(`No type role named "${name}"`);
  }
  return style;
}

/** The font stacks: the bundled IBM Plex family first, the system stack behind it. */
export const fontFamilies = tokens.type.families;
