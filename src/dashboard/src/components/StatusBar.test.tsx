import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StreamView } from "../api/marketStream.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { instrumentsFixture, snapshotFixture } from "../test/fixtures.ts";
import { StatusBar } from "./StatusBar.tsx";

const view: StreamView = {
  hub: "connected",
  market: null,
  awaitingSnapshot: true,
  error: null,
  resyncs: 0,
  rejectedDeltas: 0,
  depthRoots: null,
  refusedRoots: [],
};

function render(instrument: string): string {
  return renderToString(
    <StatusBar
      view={view}
      instrument={instrument}
      instruments={instrumentsFixture()}
    />,
  );
}

describe("StatusBar", () => {
  it("should show the selected product's 5- and 15-minute regimes from the polled summary", () => {
    const html = render("CL");

    expect([html.includes("Range"), html.includes("Trend ↓")]).toEqual([true, true]);
  });

  it("should show the regimes as warming when the product's bars are still warming up", () => {
    expect(render("GC")).toContain("Warming 3/28");
  });

  it("should show the missing-data badge when trades were dropped", () => {
    const snapshot = snapshotFixture();
    const market = fromSnapshot(
      { ...snapshot, status: { ...snapshot.status, code: "DEGRADED", missingSinceMs: Date.UTC(2026, 10, 10, 14, 30) } },
      30,
      Date.UTC(2026, 10, 10, 14, 31),
    );
    const html = renderToString(
      <StatusBar
        view={{ ...view, market, awaitingSnapshot: false }}
        instrument="ES"
        instruments={instrumentsFixture()}
      />,
    );

    expect(html).toContain("data missing since");
    expect(html).toContain("CT");
    expect(html).not.toContain('aria-label="data missing since');
  });

  it("should show approximate history when a repaired minute is still in view", () => {
    const snapshot = snapshotFixture();
    const market = fromSnapshot(
      { ...snapshot, status: { ...snapshot.status, code: "DEGRADED", approximate: true } },
      30,
      Date.UTC(2026, 10, 10, 14, 31),
    );
    const html = renderToString(
      <StatusBar
        view={{ ...view, market, awaitingSnapshot: false }}
        instrument="ES"
        instruments={instrumentsFixture()}
      />,
    );

    expect(html).toContain("approximate history");
    expect(html).toContain("DEGRADED");
    expect(html).not.toContain(">LIVE<");
  });
});
