// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultLayout } from "../domain/layout.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { AXIS_WIDTH, colors } from "../theme.ts";
import { IndicatorDock } from "./IndicatorDock.tsx";

// The dock's CVD tab replaces Order Flow's CVD subchart, so it marks warmup as the subchart did (REQUIREMENTS.md FR-61).

vi.mock("../hooks/useElementSize.ts", () => ({ useElementSize: () => ({ width: 800, height: 200 }) }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const base = fromSnapshot(snapshotFixture(), 5, 0);
const now = base.serverTimeMs;
const startMs = now - 240_000;
const watermark = now - 120_000;
const market: MarketState = {
  ...base,
  historyWatermarkMs: watermark,
  status: { ...base.status, cvdKnown: true },
  orderFlow: {
    ...base.orderFlow,
    cvd: 6,
    cvdPoints: [
      [now - 200_000, 0],
      [now - 150_000, 2],
      [now - 100_000, 5],
      [now - 50_000, 4],
    ],
  },
};

// One recording per context asked for: the crosshair overlay asks for its own after the pane draws.
let recordings: CanvasCall[][] = [];

beforeEach(() => {
  recordings = [];
  HTMLCanvasElement.prototype.getContext = (() => {
    const fake = fakeSurface(800, 200);
    recordings.push(fake.calls);
    return fake.surface.ctx;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
});

function renderDock(axisWidth?: number, shown: MarketState = market) {
  render(
    <IndicatorDock
      market={shown}
      layout={{ ...defaultLayout, indicatorPane: "cvd" }}
      candles={[]}
      indicators={shown.indicators}
      startMs={startMs}
      endMs={now}
      crosshair={createCrosshairStore()}
      showSinglePrints
      axisWidth={axisWidth}
    />,
  );
}

/** The x of each vertex the CVD line draws in `stroke`. The grid, guides and frame span the pane or sit at its edges. */
function vertices(stroke: string, plotWidth: number): number[] {
  return recordings
    .flat()
    .filter((call) => (call.method === "moveTo" || call.method === "lineTo") && call.strokeStyle === stroke)
    .map((call) => call.args[0] as number)
    .filter((x) => x > 0 && x < plotWidth)
    .map(round);
}

/** The vertical extent, in pixels, of every vertex drawn in `stroke`. */
function yExtent(stroke: string): number {
  const ys = recordings
    .flat()
    .filter((call) => (call.method === "moveTo" || call.method === "lineTo") && call.strokeStyle === stroke)
    .map((call) => call.args[1] as number);
  return ys.length === 0 ? 0 : Math.max(...ys) - Math.min(...ys);
}

/** How many horizontal guides were stroked: the dashed zero line is the only `muted` stroke in the pane. */
function guideLines(): number {
  return recordings.flat().filter((call) => call.method === "lineTo" && call.strokeStyle === colors.muted).length;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

describe("IndicatorDock CVD tab", () => {
  it("should draw the CVD before the watermark in the warmup colour and the live stretch after it in the CVD colour", () => {
    renderDock();
    const plotWidth = 800 - AXIS_WIDTH;
    const toPx = (t: number) => round(((t - startMs) / (now - startMs)) * plotWidth);

    const warm = vertices(colors.warmup, plotWidth);
    // The session CVD is +6, so the live stretch is up (the maintainer's ruling, D-48).
    const live = vertices(colors.up, plotWidth);

    expect(colors.warmup).not.toBe(colors.up);
    expect(warm).toEqual([toPx(now - 200_000), toPx(now - 150_000)]);
    // The live value now sits on the right edge, left out with the frame. No segment joins the two stretches.
    expect(live).toEqual([toPx(now - 100_000), toPx(now - 50_000)]);
  });

  it("should run the time axis across the dock less the width the caller gives for the value axis", () => {
    renderDock(240);
    const plotWidth = 800 - 240;
    const toPx = (t: number) => round(((t - startMs) / (now - startMs)) * plotWidth);

    expect(vertices(colors.up, plotWidth)).toEqual([toPx(now - 100_000), toPx(now - 50_000)]);
  });

  // The maintainer's ruling: the live line is up or down by the sign of the session CVD, as Order Flow's
  // subchart drew it (D-48), on Detail and Order Flow alike; warmup stays grey.
  it.each([
    ["up when the session CVD is positive", 6, "up"],
    ["down when the session CVD is negative", -6, "down"],
    ["the text colour when the session CVD is flat at zero", 0, "text"],
  ] as const)("should draw the live CVD stretch in %s, and the warmup stretch in warmup", (_name, cvd, expected) => {
    renderDock(undefined, { ...market, orderFlow: { ...market.orderFlow, cvd } });
    const plotWidth = 800 - AXIS_WIDTH;
    const toPx = (t: number) => round(((t - startMs) / (now - startMs)) * plotWidth);
    const styles = { up: colors.up, down: colors.down, text: colors.text } as const;

    expect(new Set(Object.values(styles)).size).toBe(3);
    for (const [name, style] of Object.entries(styles)) {
      expect(vertices(style, plotWidth), name).toEqual(name === expected ? [toPx(now - 100_000), toPx(now - 50_000)] : []);
    }
    expect(vertices(colors.bid, plotWidth)).toEqual([]);
    expect(vertices(colors.warmup, plotWidth)).toEqual([toPx(now - 200_000), toPx(now - 150_000)]);
  });

  // The subchart fitted its scale to the line in view; a zero always in range flattened a CVD far from zero.
  it("should fit the scale to the CVD in view, so a session CVD far from zero fills the pane's height, and draw no zero guide outside it", () => {
    const far: MarketState = {
      ...market,
      historyWatermarkMs: null,
      orderFlow: {
        ...market.orderFlow,
        cvd: 5_100,
        cvdPoints: [
          [now - 200_000, 4_800],
          [now - 150_000, 4_950],
          [now - 100_000, 5_000],
          [now - 50_000, 4_900],
        ],
      },
    };
    renderDock(undefined, far);
    // The value scale runs from 4 px above the bottom to 14 px below the top of the 200 px pane: 182 px. A fit to
    // 4,800–5,100 with 8% padding each side puts the line across 300 / 348 of that, about 157 px.
    const usable = 200 - 4 - 14;

    expect(yExtent(colors.up)).toBeGreaterThan(0.8 * usable);
    expect(yExtent(colors.up)).toBeLessThanOrEqual(usable);
    expect(guideLines()).toBe(0);
  });

  it("should draw the zero guide when the CVD in view crosses zero", () => {
    renderDock();

    expect(guideLines()).toBe(1);
  });

  // The subchart's own guard moved here with it.
  it("should draw no CVD line and say unknown when CVD is not known", () => {
    renderDock(undefined, { ...market, status: { ...market.status, cvdKnown: false } });
    const plotWidth = 800 - AXIS_WIDTH;
    const painted = recordings
      .flat()
      .filter((call) => call.method === "fillText")
      .map((call) => String(call.args[0]))
      .join(" | ");

    for (const style of [colors.warmup, colors.up, colors.down, colors.text, colors.bid]) expect(vertices(style, plotWidth)).toEqual([]);
    expect(painted).toContain("CVD (session)  unknown");
    expect(painted).not.toContain("+6");
  });
});
