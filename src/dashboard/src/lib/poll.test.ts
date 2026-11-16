import { describe, expect, it, vi } from "vitest";

import { poll, type Visibility } from "./poll.ts";

/** A clock the test advances by hand, and a page whose visibility it flips. */
function harness() {
  const timers: { callback: () => void; ms: number }[] = [];
  let hidden = false;
  const listeners = new Set<() => void>();
  const visibility: Visibility = {
    hidden: () => hidden,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const schedule = (callback: () => void, ms: number) => {
    const timer = { callback, ms };
    timers.push(timer);
    return () => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    };
  };
  return {
    visibility,
    schedule,
    timers,
    fire: () => timers.shift()?.callback(),
    setHidden(next: boolean) {
      hidden = next;
      for (const listener of listeners) listener();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("poll", () => {
  it("should wait one interval before the first read when it starts", () => {
    const h = harness();
    const load = vi.fn(async () => 1);
    poll(load, vi.fn(), { intervalMs: 2000, visibility: h.visibility, schedule: h.schedule });

    expect([load.mock.calls.length, h.timers[0]?.ms]).toEqual([0, 2000]);
  });

  it("should hand each answer on and schedule the next read when a read succeeds", async () => {
    const h = harness();
    const onData = vi.fn();
    poll(async () => 7, onData, { intervalMs: 2000, visibility: h.visibility, schedule: h.schedule });
    h.fire();
    await flush();

    expect([onData.mock.calls, h.timers.length]).toEqual([[[7]], 1]);
  });

  it("should keep polling when a read fails", async () => {
    const h = harness();
    const onData = vi.fn();
    poll(() => Promise.reject(new Error("down")), onData, { intervalMs: 2000, visibility: h.visibility, schedule: h.schedule });
    h.fire();
    await flush();

    expect([onData.mock.calls.length, h.timers.length]).toEqual([0, 1]);
  });

  it("should not read while the page is hidden", () => {
    const h = harness();
    const load = vi.fn(async () => 1);
    poll(load, vi.fn(), { intervalMs: 2000, visibility: h.visibility, schedule: h.schedule });
    h.setHidden(true);

    expect([h.timers.length, load.mock.calls.length]).toEqual([0, 0]);
  });

  it("should read at once when the page is shown again", () => {
    const h = harness();
    const load = vi.fn(async () => 1);
    poll(load, vi.fn(), { intervalMs: 2000, visibility: h.visibility, schedule: h.schedule });
    h.setHidden(true);
    h.setHidden(false);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("should abort the read in flight and hand nothing on when it is stopped", async () => {
    const h = harness();
    const onData = vi.fn();
    let signal: AbortSignal | null = null;
    const stop = poll(
      (s) => {
        signal = s;
        return Promise.resolve(1);
      },
      onData,
      { intervalMs: 2000, visibility: h.visibility, schedule: h.schedule },
    );
    h.fire();
    stop();
    await flush();

    expect([(signal as AbortSignal | null)?.aborted, onData.mock.calls.length, h.timers.length]).toEqual([true, 0, 0]);
  });
});
