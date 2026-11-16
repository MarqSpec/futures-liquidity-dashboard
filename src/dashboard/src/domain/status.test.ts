import { describe, expect, it } from "vitest";

import { chipTone } from "./status.ts";

describe("chipTone", () => {
  it("should be amber when the feed is simulated", () => {
    expect(chipTone("SIMULATED")).toBe("simulated");
  });

  it("should never be the live tone when the feed is simulated", () => {
    expect(chipTone("SIMULATED")).not.toBe(chipTone("LIVE"));
  });

  it("should be red when the feed is stale", () => {
    expect(chipTone("STALE")).toBe("bad");
  });
});
