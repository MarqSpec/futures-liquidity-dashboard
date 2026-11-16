// Renders tokens.json as tokens.css. scripts/generate-tokens-css.ts writes it; tokensCss.test.ts checks the two agree.

import { aliasTarget, type ThemedToken, type ThemeId, type TokenFile } from "./tokenFile.ts";

function cssValue(value: string): string {
  const target = aliasTarget(value);
  return target === undefined ? value : `var(--${target})`;
}

/** The token's declaration in `theme`, or undefined when the Light block need not repeat it. */
function themedDeclaration(token: ThemedToken, theme: ThemeId): string | undefined {
  if (typeof token.value !== "string") {
    return `  --${token.name}: ${cssValue(token.value[theme])};`;
  }
  // A single literal value inherits into Light; an alias must be re-declared to resolve against Light's target.
  if (theme === "light" && aliasTarget(token.value) === undefined) {
    return undefined;
  }
  return `  --${token.name}: ${cssValue(token.value)};`;
}

function rule(selector: string, declarations: readonly (string | undefined)[]): string {
  const lines = declarations.filter((line): line is string => line !== undefined);
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}

/** The stylesheet for a token file: Terminal colours and shadows, their Light overrides, then the shared scales. */
export function renderTokensCss(file: TokenFile): string {
  const themed = [...file.color.tokens, ...file.shadow.tokens];
  const scalars = [
    ...file.spacing.tokens,
    ...file.radius.tokens,
    ...file.size.tokens,
    ...file.opacity.tokens,
    ...file.zIndex.tokens,
  ];
  return [
    "/* Generated from tokens.json by scripts/generate-tokens-css.ts: do not edit; run `pnpm run tokens`. */\n",
    rule(
      ':root,\n[data-theme="dark"]',
      themed.map((token) => themedDeclaration(token, "dark")),
    ),
    rule(
      '[data-theme="light"]',
      themed.map((token) => themedDeclaration(token, "light")),
    ),
    rule(":root", [
      `  --font-sans: ${file.type.families.sans};`,
      `  --font-mono: ${file.type.families.mono};`,
      ...scalars.map((token) => `  --${token.name}: ${token.value};`),
    ]),
  ].join("\n");
}
