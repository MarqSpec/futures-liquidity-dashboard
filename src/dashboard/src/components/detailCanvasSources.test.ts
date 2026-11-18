import { describe, expect, it } from "vitest";

import heatRamp from "../domain/heatRamp.ts?raw";
import signals from "../domain/signals.ts?raw";
import volumeDots from "../domain/volumeDots.ts?raw";
import canvas from "../lib/canvas.ts?raw";
import drawFootprint from "./drawFootprint.ts?raw";
import drawMainChart from "./drawMainChart.ts?raw";
import drawProfile from "./drawProfile.ts?raw";
import drawSeriesPane from "./drawSeriesPane.ts?raw";
import drawVolumePane from "./drawVolumePane.ts?raw";
import indicatorDock from "./IndicatorDock.tsx?raw";
import mainChart from "./MainChart.tsx?raw";
import profilePanel from "./ProfilePanel.tsx?raw";
import timePane from "./TimePane.tsx?raw";

// Every Detail canvas takes its colours from the token module (via theme.ts), so a theme can swap them all.

/**
 * The text of `export const <name>` or `export function <name>` up to the next closing brace at the start of a line;
 * empty when there is none, which fails the guard below.
 */
function declarationOf(source: string, name: string): string {
  const match = new RegExp(`^export (?:const|function) ${name}\\b`, "m").exec(source);
  const end = match ? source.indexOf("\n}", match.index) : -1;
  return match && end >= 0 ? source.slice(match.index, end + 2) : "";
}

const sources: Readonly<Record<string, string>> = {
  "domain/heatRamp.ts": heatRamp,
  "lib/canvas.ts": canvas,
  "components/drawFootprint.ts": drawFootprint,
  "components/drawMainChart.ts": drawMainChart,
  "components/drawProfile.ts": drawProfile,
  "components/drawSeriesPane.ts": drawSeriesPane,
  "components/drawVolumePane.ts": drawVolumePane,
  "components/MainChart.tsx": mainChart,
  "components/ProfilePanel.tsx": profilePanel,
  "components/TimePane.tsx": timePane,
  // Only aggressorColor, which the main chart's volume dots and last-trade flash use: the rest of the file is the
  // Order Flow canvas's, step 7.
  "domain/volumeDots.ts aggressorColor": declarationOf(volumeDots, "aggressorColor"),
  "components/IndicatorDock.tsx": indicatorDock,
  // The bias colours and,, the Order Flow event-marker palette: the whole file.
  "domain/signals.ts": signals,
};

/** Hex colours, numeric rgb()/hsl() colours and named colours, outside comments. */
function colourLiterals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return code.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(\s*\d|["'`](?:white|black|red|green|blue|yellow|orange|gray|grey)["'`]/gi) ?? [];
}

describe("Detail canvas sources", () => {
  it.each(Object.keys(sources))("should hold no colour literal when %s draws", (file) => {
    expect(sources[file]).not.toBe("");
    expect(colourLiterals(sources[file] ?? "")).toEqual([]);
  });

  it("should cut out only the named declaration when one source is narrowed", () => {
    const source = [
      "export function aggressorColorOf(side: string): string {",
      '  return "#123456";',
      "}",
      "export function aggressorColor(side: string): string {",
      "  return colors.up;",
      "}",
      "export const biasColors = {",
      "  Bullish: colors.up,",
      "};",
      'export const other = { a: "#123456" };',
    ].join("\n");

    expect(declarationOf(source, "aggressorColor")).toBe(["export function aggressorColor(side: string): string {", "  return colors.up;", "}"].join("\n"));
    expect(declarationOf(source, "biasColors")).toBe(["export const biasColors = {", "  Bullish: colors.up,", "}"].join("\n"));
    expect(declarationOf(source, "missing")).toBe("");
  });

  it("should find each kind of literal when a source carries one", () => {
    expect(colourLiterals('ctx.fillStyle = "#2a3242"; x = "rgba(11, 14, 20, 0.9)"; y = "white";')).toEqual([
      "#2a3242",
      "rgba(1",
      '"white"',
    ]);
  });

  it("should ignore a channel template and a comment when neither is a literal colour", () => {
    expect(colourLiterals("// was #10151e\nreturn `rgba(${triplet}, ${a})`;")).toEqual([]);
  });
});
