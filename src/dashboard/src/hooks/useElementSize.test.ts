import { describe, expect, it } from "vitest";

import { MAX_DEVICE_EDGE_PX, clampElementSize } from "./useElementSize.ts";

const desktop = { width: 1920, height: 1080 };

describe("clampElementSize", () => {
  it("should leave a normal pane unchanged when it fits the viewport", () => {
    expect(clampElementSize(800, 600, desktop)).toEqual({ width: 800, height: 600 });
  });

  it("should cap a runaway height when a layout loop reports about 1.5 million pixels", () => {
    expect(clampElementSize(1200, 1_500_000, desktop)).toEqual({ width: 1200, height: 1080 * 4 });
  });

  it("should cap an edge at the maximum device size when the viewport is larger than that", () => {
    expect(clampElementSize(20_000, 100, { width: 10_000, height: 1000 }).width).toBe(MAX_DEVICE_EDGE_PX);
  });

  it("should use the device cap when the viewport size is unknown", () => {
    expect(clampElementSize(1_500_000, 100, { width: 0, height: 0 })).toEqual({
      width: MAX_DEVICE_EDGE_PX,
      height: 100,
    });
  });

  it("should treat a non-finite measurement as empty", () => {
    expect(clampElementSize(Number.NaN, -4, desktop)).toEqual({ width: 0, height: 0 });
  });
});
