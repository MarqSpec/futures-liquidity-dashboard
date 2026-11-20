import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { fromSnapshot } from "../domain/merge.ts";
import { formatTicks } from "../domain/format.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { DomLadder } from "./DomLadder.tsx";

const base = fromSnapshot(snapshotFixture(), 5, 0);
const market = {
  ...base,
  ladder: {
    bids: [
      [100, 5],
      [99, 3],
      [98, 8],
    ],
    asks: [
      [101, 4],
      [102, 6],
      [103, 2],
    ],
  },
  liquidity: { ...base.liquidity, bestBid: 100, bestAsk: 101, spreadTicks: 1 },
} as typeof base;

function render(): string {
  return renderToString(<DomLadder market={market} isKindOn={() => true} />).replaceAll("<!-- -->", "");
}

function rows(html: string, className: string): string[] {
  return html.match(new RegExp(`<tr class="${className}"[^>]*>.*?</tr>`, "g")) ?? [];
}

describe("DomLadder", () => {
  it("should mark exactly the best bid and the best ask rows when the book has several levels", () => {
    const best = rows(render(), "best");

    expect(best).toHaveLength(2);
    expect(best.some((row) => row.includes(formatTicks(100, market.instrument)))).toBe(true);
    expect(best.some((row) => row.includes(formatTicks(101, market.instrument)))).toBe(true);
  });

  it("should leave the other rows unmarked when the book has several levels", () => {
    const html = render();

    expect(html).toContain(formatTicks(98, market.instrument));
    expect(rows(html, "best").join("")).not.toContain(formatTicks(98, market.instrument));
  });

  it("should draw the ladder with the design-system ladder table and the DOM mark", () => {
    const html = render();

    expect(html).toContain('class="ld-ladder"');
    expect(html).toContain("ld-dom-mark");
    expect(html).toContain("DOM · 20/side");
  });

  it("should show the spread as its own row between the last ask and the first bid", () => {
    const html = render();
    const spread = html.indexOf('class="spread"');
    const lastAsk = html.indexOf(`ask-price">${formatTicks(101, market.instrument)}<`);
    const firstBid = html.indexOf(`bid-price">${formatTicks(100, market.instrument)}<`);

    expect(spread).toBeGreaterThan(-1);
    expect(lastAsk).toBeGreaterThan(-1);
    expect(firstBid).toBeGreaterThan(spread);
    expect(spread).toBeGreaterThan(lastAsk);
    expect(html).toContain("spread 1 ticks");
  });

  it("should mark where an ended wall stood, adding an empty row when its level is gone", () => {
    const wall = (priceTicks: number, outcome: string) => ({ side: "Bid", priceTicks, peakQuantity: 90, filled: 10, pulled: 80, stoodMs: 30_000, endedMs: 0, outcome });
    const gapped = {
      ...market,
      ladder: { bids: [[100, 5], [98, 8]], asks: [[101, 4], [103, 2]] },
      liquidity: { ...market.liquidity, walls: [], endedWalls: [wall(99, "Pulled"), wall(103, "Filled"), wall(90, "Pulled")] },
    } as typeof market;

    const html = renderToString(<DomLadder market={gapped} isKindOn={() => true} />).replaceAll("<!-- -->", "");
    const gone = html.match(new RegExp(`<tr[^>]*>(?:(?!</tr>).)*bid-price">${formatTicks(99, market.instrument)}<.*?</tr>`))?.[0] ?? "";

    expect(gone).toContain("ended bid wall, mostly pulled after 30.0 s");
    expect(gone).toContain("▯");
    expect(html).toContain("ended bid wall, mostly filled after 30.0 s");
    expect(html).not.toContain(formatTicks(90, market.instrument));
  });
});
