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

  describe("net liquidity flow", () => {
    const flow = (over: Partial<Liquidity["flow10s"]>): Liquidity["flow10s"] => ({
      ...market.liquidity.flow10s,
      bidAdded: 0,
      bidPulled: 0,
      bidFilled: 0,
      askAdded: 0,
      askPulled: 0,
      askFilled: 0,
      netFlowBid: 0,
      netFlowAsk: 0,
      ...over,
    });
    const rowOf = (html: string, name: string) => html.match(new RegExp(`<tr><th scope="row">${name}</th>.*?</tr>`))?.[0] ?? "";

    it("should print the server's net with its sign in the text when a side is building or thinning", () => {
      const html = render({ flow10s: flow({ bidAdded: 100, bidPulled: 30, bidFilled: 20, netFlowBid: 70, askAdded: 10, askPulled: 45, askFilled: 5, netFlowAsk: -35 }) });

      expect(rowOf(html, "bid 10s")).toContain(">+70<");
      expect(rowOf(html, "ask 10s")).toContain(">−35<");
    });

    it("should draw the bar on the right for building and on the left for thinning, in the up and down colours", () => {
      const html = render({ flow10s: flow({ netFlowBid: 70, netFlowAsk: -35 }) });

      expect(rowOf(html, "bid 10s")).toMatch(/class="flow-net-up" style="width:50%;left:50%"/);
      expect(rowOf(html, "ask 10s")).toMatch(/class="flow-net-down" style="width:25%;right:50%"/);
      expect(rowOf(html, "bid 10s")).toContain("ld-up");
      expect(rowOf(html, "ask 10s")).toContain("ld-down");
    });

    it("should scale each window to its own larger side when the two windows differ in size", () => {
      const html = render({ flow10s: flow({ netFlowBid: 10, netFlowAsk: -5 }), flow60s: flow({ netFlowBid: -400, netFlowAsk: 100 }) });

      expect(rowOf(html, "bid 10s")).toContain("width:50%");
      expect(rowOf(html, "ask 60s")).toContain("width:12.5%");
      expect(rowOf(html, "bid 60s")).toContain("width:50%");
    });

    it("should show a plain zero with no bar and no colour when a side's adds equal its pulls", () => {
      const html = render({ flow10s: flow({ bidFilled: 50, netFlowBid: 0, netFlowAsk: 0 }) });

      expect(rowOf(html, "bid 10s")).toContain(">0<");
      expect(rowOf(html, "bid 10s")).not.toMatch(/flow-net-(up|down)|ld-up|ld-down/);
    });

    it("should not subtract fills when a side's resting size is eaten by trades", () => {
      const html = render({ flow10s: flow({ bidAdded: 40, bidPulled: 10, bidFilled: 60, netFlowBid: 30 }) });

      expect(rowOf(html, "bid 10s")).toContain(">+30<");
      expect(rowOf(html, "bid 10s")).not.toContain("−30");
    });

    it("should state the definition on the column and beside the table", () => {
      const html = render({});

      expect(html).toMatch(/<th scope="col">net<span class="visually-hidden"> \(added minus pulled\)<\/span><\/th>/);
      expect(html).toContain("net = added − pulled, fills not counted");
    });
  });
});
