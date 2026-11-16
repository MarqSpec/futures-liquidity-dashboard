import { describe, expect, it } from "vitest";

import { chartZoomIn, chartZoomOut } from "./chartCursor.ts";
import { clampPriceZoom, clampWindow, defaultWindow, LIVE_EDGE_PAD, nextPriceZoom, panOffsetMs, zoomTimeAbout } from "./viewWindow.ts";

describe("clampWindow", () => {
  it("should not zoom in past one minute when asked for less", () => {
    expect(clampWindow({ spanMs: 1000, offsetMs: 0, priceZoom: 1 }, 600_000).spanMs).toBe(60_000);
  });

  it("should not show more than the loaded history when asked for more", () => {
    expect(clampWindow({ spanMs: 10_000_000, offsetMs: 0, priceZoom: 1 }, 600_000).spanMs).toBe(600_000);
  });

  it("should not pan past the start of the history when dragged too far", () => {
    expect(clampWindow({ spanMs: 120_000, offsetMs: 9_999_999, priceZoom: 1 }, 600_000).offsetMs).toBe(480_000);
  });

  it("should not pan into the future when dragged forward", () => {
    expect(clampWindow({ spanMs: 120_000, offsetMs: -5000, priceZoom: 1 }, 600_000).offsetMs).toBe(0);
  });
});

describe("defaultWindow", () => {
  it("should show the whole history and follow live when created", () => {
    expect(defaultWindow(15)).toEqual({ spanMs: 900_000, offsetMs: 0, priceZoom: 1 });
  });
});

describe("nextPriceZoom", () => {
  it("should clamp price zoom when it is written so a reverse notch is not a dead zone", () => {
    expect(clampPriceZoom(100)).toBe(20);
    expect(clampPriceZoom(0)).toBe(0.05);
    expect(clampPriceZoom(Number.NaN)).toBe(1);
    expect(nextPriceZoom(20, chartZoomOut)).toBe(20);
    expect(nextPriceZoom(100, chartZoomOut)).toBe(20);
    expect(nextPriceZoom(20, chartZoomIn)).toBeCloseTo(20 * chartZoomIn);
    expect(nextPriceZoom(0.05, chartZoomIn)).toBe(0.05);
    expect(nextPriceZoom(0.01, chartZoomOut)).toBeCloseTo(0.05 * chartZoomOut);
  });
});

describe("zoomTimeAbout", () => {
  const now = 1_000_000;
  const at = (spanMs: number, offsetMs: number, fraction: number) => {
    const end = now + LIVE_EDGE_PAD * spanMs - offsetMs;
    return end - spanMs + fraction * spanMs;
  };

  it("should keep the time under the pointer across two notches and stay inside the history", () => {
    const historyMs = 600_000;
    const first = zoomTimeAbout(300_000, 0, 0.3, chartZoomIn, historyMs);
    const second = zoomTimeAbout(first.spanMs, first.offsetMs, 0.3, chartZoomIn, historyMs);
    expect(at(second.spanMs, second.offsetMs, 0.3)).toBeCloseTo(at(300_000, 0, 0.3));
    expect(second.spanMs).toBeGreaterThanOrEqual(60_000);
    const widest = zoomTimeAbout(300_000, 0, 0.5, 10, historyMs);
    expect(widest.spanMs).toBe(historyMs);
    expect(widest.offsetMs).toBe(0);
    const dragged = panOffsetMs(0, 120, 300_000, 400, historyMs);
    expect(dragged).toBeGreaterThan(0);
    expect(panOffsetMs(0, -500, 300_000, 400, historyMs)).toBe(0);
    expect(panOffsetMs(0, 10_000, 300_000, 400, historyMs)).toBe(historyMs - 300_000);
  });
});
