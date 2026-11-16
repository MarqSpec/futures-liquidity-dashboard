import { afterEach, describe, expect, it } from "vitest";

import { activePerfProbe, percentile, perfRequested, perfSampleLimit, startPerfProbe, timeDraw, type DashPerf, type PerfHost } from "./perfProbe.ts";

/** A host whose frames the test steps by hand and whose clock it sets. */
function fakeHost() {
  let pending: ((timeMs: number) => void) | null = null;
  let clock = 0;
  const target: { __dashPerf?: DashPerf } = {};
  const host: PerfHost = {
    requestAnimationFrame(callback) {
      pending = callback;
      return 1;
    },
    cancelAnimationFrame() {
      pending = null;
    },
    now: () => clock,
    target,
  };
  return {
    host,
    target,
    frame(timeMs: number) {
      const callback = pending;
      pending = null;
      callback?.(timeMs);
    },
    hasPendingFrame: () => pending !== null,
    setClock(ms: number) {
      clock = ms;
    },
  };
}

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
});

describe("perfRequested", () => {
  it("should be on when the query string has perf=1", () => {
    expect(perfRequested("?instrument=ES&perf=1")).toBe(true);
  });

  it.each(["", "?perf=0", "?perf", "?other=1"])("should be off when the query string is %j", (search) => {
    expect(perfRequested(search)).toBe(false);
  });
});

describe("timeDraw", () => {
  it("should call through and record nothing when the probe is off", () => {
    expect([timeDraw(() => 42), activePerfProbe()]).toEqual([42, null]);
  });

  it("should record the draw's duration when the probe is on", () => {
    const fake = fakeHost();
    stop = startPerfProbe(fake.host);
    timeDraw(() => fake.setClock(3.5));

    expect(fake.target.__dashPerf?.draws).toEqual([3.5]);
  });
});

describe("startPerfProbe", () => {
  it("should record the time between frames when frames arrive", () => {
    const fake = fakeHost();
    stop = startPerfProbe(fake.host);
    fake.frame(100);
    fake.frame(116);
    fake.frame(150);

    expect(fake.target.__dashPerf?.frames).toEqual([16, 34]);
  });

  it("should keep only the last samples when frames keep coming", () => {
    const fake = fakeHost();
    stop = startPerfProbe(fake.host);
    for (let i = 0; i <= perfSampleLimit + 10; i++) fake.frame(i * 16);

    expect(fake.target.__dashPerf?.frames).toHaveLength(perfSampleLimit);
  });

  it("should forget every sample when it is reset", () => {
    const fake = fakeHost();
    stop = startPerfProbe(fake.host);
    fake.frame(0);
    fake.frame(16);
    fake.target.__dashPerf?.reset();

    expect(fake.target.__dashPerf?.frames).toEqual([]);
  });

  it("should stop the frame loop and unpublish the probe when it is stopped", () => {
    const fake = fakeHost();
    startPerfProbe(fake.host)();

    expect([fake.hasPendingFrame(), fake.target.__dashPerf, activePerfProbe()]).toEqual([false, undefined, null]);
  });
});

describe("percentile", () => {
  it("should pick by nearest rank when there are samples", () => {
    expect([percentile([5, 1, 4, 2, 3], 50), percentile([5, 1, 4, 2, 3], 95)]).toEqual([3, 5]);
  });

  it("should be null when there are no samples", () => {
    expect(percentile([], 95)).toBeNull();
  });
});
