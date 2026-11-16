// The design system's token file: its schema, and how a colour token resolves in a theme.
// No JSON import here, so scripts/generate-tokens-css.ts can load it under plain Node.

import { z } from "zod";

export const THEMES = ["dark", "light"] as const;

/** `dark` is Terminal, the default; `light` is Light. */
export type ThemeId = (typeof THEMES)[number];

const name = z.string().regex(/^[a-z0-9-]+$/);
const themed = z.object({ dark: z.string(), light: z.string() });
const themedToken = z.object({ name, value: z.union([z.string(), themed]), usage: z.string() });
const scalarToken = z.object({ name, value: z.string(), usage: z.string() });
const typeStyle = z.object({
  name,
  fontSize: z.string(),
  lineHeight: z.string(),
  fontWeight: z.number(),
  letterSpacing: z.string().optional(),
  usage: z.string(),
});

const tokenFileSchema = z.object({
  name: z.string(),
  version: z.number(),
  color: z.object({
    themes: z.array(z.object({ id: z.enum(THEMES), name: z.string() })),
    tokens: z.array(themedToken),
  }),
  type: z.object({
    families: z.object({ sans: z.string(), mono: z.string() }),
    groups: z.array(z.object({ name: z.string(), family: z.enum(["sans", "mono"]), styles: z.array(typeStyle) })),
  }),
  spacing: z.object({ tokens: z.array(scalarToken) }),
  radius: z.object({ tokens: z.array(scalarToken) }),
  shadow: z.object({ tokens: z.array(themedToken) }),
  size: z.object({ tokens: z.array(scalarToken) }),
  opacity: z.object({ tokens: z.array(scalarToken) }),
  zIndex: z.object({ tokens: z.array(scalarToken) }),
});

export type TokenFile = z.infer<typeof tokenFileSchema>;
export type ThemedToken = z.infer<typeof themedToken>;
export type TypeStyle = z.infer<typeof typeStyle>;

/** Validates a token file; throws on a missing group or a malformed token. */
export function parseTokenFile(raw: unknown): TokenFile {
  return tokenFileSchema.parse(raw);
}

const ALIAS = /^\{([a-z0-9-]+)\}$/;

/** The token a `{name}` value refers to, or undefined when the value is literal. */
export function aliasTarget(value: string): string | undefined {
  return ALIAS.exec(value)?.[1];
}

/** A colour token's literal value in `theme`, following `{alias}` references. */
export function resolveColor(file: TokenFile, tokenName: string, theme: ThemeId): string {
  const seen = new Set<string>();
  let current = tokenName;
  for (;;) {
    if (seen.has(current)) {
      throw new Error(`Colour token alias cycle through "${current}"`);
    }
    seen.add(current);
    const token = file.color.tokens.find((candidate) => candidate.name === current);
    if (!token) {
      throw new Error(`No colour token named "${current}"`);
    }
    const value = typeof token.value === "string" ? token.value : token.value[theme];
    const target = aliasTarget(value);
    if (target === undefined) {
      return value;
    }
    current = target;
  }
}
