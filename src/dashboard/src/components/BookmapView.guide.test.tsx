// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLayout } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";
import type { TrailGuide } from "../domain/bookmap.ts";

const drawn = vi.hoisted(() => vi.fn());

vi.mock("./drawBookmap.ts", () => ({
  drawBookmap: (...args: unknown[]) => drawn(...args),
  drawBookmapHover: () => undefined,
}));

vi.mock("../lib/canvas.ts", () => ({
  prepareSurface: () => ({ ctx: {}, width: 800, height: 600 }),
}));

vi.mock("../hooks/useElementSize.ts", () => ({ useElementSize: () => ({ width: 800, height: 600 }) }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const base = fromSnapshot(snapshotFixture(), 5, 0);

afterEach(() => {
  cleanup();
  drawn.mockClear();
});

function withReclaim(serverTimeMs: number) {
  const returnedAt = base.serverTimeMs - 5_000;
  return {
    ...base,
    serverTimeMs,
    historyWatermarkMs: null,
    prints: [
      { sourceTimeMs: returnedAt - 1_000, priceTicks: 110, quantity: 1, aggressor: "buy", sequence: 1 },
      { sourceTimeMs: returnedAt, priceTicks: 100, quantity: 1, aggressor: "sell", sequence: 2 },
    ],
    profiles: [
      {
        window: "session",
        bins: [],
        total: 1,
        poc: 80,
        vah: null,
        val: null,
        vaFraction: 0.7,
        partialSinceMs: null,
        missingRanges: [],
        approximateRanges: [],
        hvn: [],
        lvn: [70],
      },
    ],
    orderFlow: {
      ...base.orderFlow,
      keyLevels: [{ name: "PDH", priceTicks: 100, isHigh: true }],
    },
  };
}

function lastGuide(): TrailGuide | null {
  const call = drawn.mock.calls.at(-1);
  const model = call?.[1] as { guide?: TrailGuide | null } | undefined;
  return model?.guide ?? null;
}

describe("BookmapView trail guide", () => {
  it("should drop the trail guide when its reclaim scrolls out of the window", () => {
    const visible = withReclaim(base.serverTimeMs);
    const { rerender } = render(
      <BookmapView market={visible} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />,
    );

    expect(screen.getByLabelText(`Order Flow ${base.root}`)).toBeTruthy();
    expect(lastGuide()).not.toBeNull();
    expect(lastGuide()?.heading).toContain("Read-only");

    rerender(
      <BookmapView
        market={withReclaim(base.serverTimeMs + 10 * 60_000)}
        layout={defaultLayout}
        viewWindow={defaultWindow(5)}
        onWindow={() => undefined}
        onReading={() => undefined}
      />,
    );

    expect(lastGuide()).toBeNull();
  });
});
