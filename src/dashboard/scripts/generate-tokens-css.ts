// Regenerates src/design/tokens.css from src/design/tokens.json: `pnpm run tokens` (Node 24 strips the types).
// src/design/tokensCss.test.ts fails while the two disagree.

import { readFileSync, writeFileSync } from "node:fs";

import { parseTokenFile } from "../src/design/tokenFile.ts";
import { renderTokensCss } from "../src/design/tokensCss.ts";

const json = new URL("../src/design/tokens.json", import.meta.url);
const css = new URL("../src/design/tokens.css", import.meta.url);

writeFileSync(css, renderTokensCss(parseTokenFile(JSON.parse(readFileSync(json, "utf8")))));
console.log(`wrote ${css.pathname}`);
