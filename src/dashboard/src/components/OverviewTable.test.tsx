import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { instrumentSummaryFixture, instrumentsFixture } from "../test/fixtures.ts";
import { OverviewTable } from "./OverviewTable.tsx";

const noop = () => undefined;

function render(watchlist: readonly string[] = ["CL"]): string {
  return renderToString(<OverviewTable summaries={instrumentsFixture()} watchlist={watchlist} active="ES" refused={[]} onOpen={noop} onWatch={noop} />);
}

describe("OverviewTable", () => {
  it("should give every product a button that opens it in Detail", () => {
    const html = render();

    expect(["Open ES in Detail", "Open CL in Detail", "Open GC in Detail"].every((label) => html.includes(label))).toBe(true);
  });

  it("should group the watchlist before the sectors when nothing is sorted", () => {
    const html = render();

    expect([html.indexOf("Watchlist") < html.indexOf("Equity index"), html.indexOf("Equity index") < html.indexOf("Metals")]).toEqual([
      true,
      true,
    ]);
  });

  it("should label each regime and the agreement when the server publishes them", () => {
    const html = render();

    expect(["Trend ↑", "Range", "Trend ↓", "Warming 3/28", "Agree", "Conflict", "Mixed"].every((text) => html.includes(text))).toBe(true);
  });

  it("should mark every sortable header as unsorted when the table is grouped", () => {
    const html = render();

    expect([html.match(/aria-sort="none"/g)?.length, html.includes('aria-sort="ascending"')]).toEqual([14, false]);
  });

  it("should mark a product without depth subtly when the server holds none", () => {
    expect(render()).toContain("no DOM");
  });

  it("should show the newest signal's kind and the 15-minute count when one fired", () => {
    expect(render()).toContain("· 4/15m");
  });

  it("should colour the signal's kind from its bias token variable so the row follows the theme without a re-render", () => {
    const html = render();

    expect(html).toMatch(/<span style="color:var\(--bias-(?:bullish|bearish|neutral)\)">/);
    expect(html).not.toMatch(/style="color:#/);
  });

  it("should escape server text rather than render it as markup", () => {
    const hostile = [instrumentSummaryFixture({ name: "<img src=x onerror=alert(1)>" })];

    const html = renderToString(<OverviewTable summaries={hostile} watchlist={[]} active="ES" refused={[]} onOpen={noop} onWatch={noop} />);

    expect(html).not.toContain("<img src=x");
  });

  it("should say so when the API listed no products", () => {
    expect(renderToString(<OverviewTable summaries={[]} watchlist={[]} active="ES" refused={[]} onOpen={noop} onWatch={noop} />)).toContain("No products listed yet.");
  });

  // (REQUIREMENTS.md FR-57, FR-83)
  it("should mark the rate thin, with the rule's numbers in its hint, when the product's tape is thin", () => {
    const tape = { state: "Thin" as const, rate: 0.1, baselineRate: 4, thinBelowRate: 1, baselineMinutes: 30 };
    const html = renderToString(
      <OverviewTable
        summaries={[instrumentSummaryFixture({ root: "ES" }, { tradeRate: 0.1, tape }), instrumentSummaryFixture({ root: "CL" }, { tradeRate: 3 })]}
        watchlist={[]}
        active="ES"
        refused={[]}
        onOpen={noop}
        onWatch={noop}
      />,
    ).replaceAll("<!-- -->", "");

    expect(html).toContain('title="Tape thin: 0.1/s against a 30-minute median of 4.0/s; thin below 1.0/s"');
    expect(html.match(/class="tape-tag tape-thin"/g)).toHaveLength(1);
  });
});
