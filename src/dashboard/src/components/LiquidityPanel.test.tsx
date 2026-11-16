import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Liquidity } from "../api/schemas.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { LiquidityPanel } from "./LiquidityPanel.tsx";

const market = fromSnapshot(snapshotFixture(), 5, 0);

function render(change: Partial<Liquidity>): string {
  return renderToString(<LiquidityPanel liquidity={{ ...market.liquidity, ...change }} spec={market.instrument} />).replaceAll("<!-- -->", "");
}

const row = (levels: number, imbalance: number | null) => ({ levels, bid: 100, ask: 100, imbalance });

function widths(html: string): { bid: number; ask: number } | null {
  const bid = html.match(/<span class="bid" style="width:([\d.]+)%">/)?.[1];
  const ask = html.match(/<span class="ask" style="width:([\d.]+)%">/)?.[1];
  return bid === undefined || ask === undefined ? null : { bid: Number(bid), ask: Number(ask) };
}

describe("LiquidityPanel", () => {
  it("should draw the bid from the left at 80% and print 80/20 when the book is bid-heavy at ten levels", () => {
    const html = render({ depth: [row(1, 0), row(5, 0.2), row(10, 0.6)] });

    const bar = widths(html);
    expect(bar?.bid).toBeCloseTo(80, 6);
    expect(bar?.ask).toBeCloseTo(20, 6);
    expect(html).toContain("80/20");
  });

  it("should read the deepest depth row rather than the first when several are summarised", () => {
    const html = render({ depth: [row(1, -0.8), row(5, -0.2), row(10, 0.6)] });

    expect(html).toContain("80/20");
    expect(html).not.toContain("10/90");
  });

  it("should draw no bar when the deepest imbalance is null", () => {
    const html = render({ depth: [row(1, 0.5), row(10, null)] });

    expect(widths(html)).toBeNull();
    expect(html).not.toContain("ld-imbalance-read");
  });

  it("should draw no bar when no depth row is summarised", () => {
    expect(widths(render({ depth: [] }))).toBeNull();
  });

  it("should colour a positive delta up and a negative delta down when the deltas have a sign", () => {
    const html = render({ cumulativeDelta: 500, delta60s: -300 });

    expect(html).toMatch(/<dt>Cum\. delta<\/dt><dd class="ld-up">\+500<\/dd>/);
    expect(html).toMatch(/<dt>Delta 60 s<\/dt><dd class="ld-down">−300<\/dd>/);
  });

  it("should leave a zero delta uncoloured when the delta is flat", () => {
    expect(render({ cumulativeDelta: 0, delta60s: 0 })).toMatch(/<dt>Cum\. delta<\/dt><dd>0<\/dd>/);
  });
});
