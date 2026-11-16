import { describe, expect, it, vi } from "vitest";

import { canvasFontWatcher, type FontSource } from "./canvasFonts.ts";

// Canvases draw before the bundled fonts load; each one redraws once they have.

function source(): { readonly fonts: FontSource; readonly loaded: () => void; readonly fail: () => void } {
  let resolve = () => {};
  let reject = () => {};
  const ready = new Promise<void>((done, failed) => {
    resolve = done;
    reject = () => failed(new Error("font failed"));
  });
  return { fonts: { load: vi.fn(() => ready), ready }, loaded: () => resolve(), fail: () => reject() };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("canvasFontWatcher", () => {
  it("should load every canvas font and bump the epoch once when they are ready", async () => {
    const { fonts, loaded } = source();
    const watcher = canvasFontWatcher(() => fonts, ["400 10px Mono", "400 11px Mono"]);
    const listener = vi.fn();

    watcher.subscribe(listener);
    expect(watcher.epoch()).toBe(0);
    loaded();
    await settle();

    expect(fonts.load).toHaveBeenCalledWith("400 10px Mono");
    expect(fonts.load).toHaveBeenCalledWith("400 11px Mono");
    expect(watcher.epoch()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("should start loading only once when several canvases subscribe", async () => {
    const { fonts, loaded } = source();
    const watcher = canvasFontWatcher(() => fonts, ["400 10px Mono"]);
    const first = vi.fn();
    const second = vi.fn();

    watcher.subscribe(first);
    watcher.subscribe(second);
    loaded();
    await settle();

    expect(fonts.load).toHaveBeenCalledTimes(1);
    expect(watcher.epoch()).toBe(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("should stop telling a canvas when it unsubscribes", async () => {
    const { fonts, loaded } = source();
    const watcher = canvasFontWatcher(() => fonts, ["400 10px Mono"]);
    const listener = vi.fn();

    const unsubscribe = watcher.subscribe(listener);
    unsubscribe();
    loaded();
    await settle();

    expect(listener).not.toHaveBeenCalled();
  });

  it("should keep the epoch and log when every font fails to load", async () => {
    const { fonts, fail } = source();
    const watcher = canvasFontWatcher(() => fonts, ["400 10px Mono"]);
    const listener = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    watcher.subscribe(listener);
    fail();
    await settle();

    expect(watcher.epoch()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("should bump the epoch for the faces that loaded and log the one that failed when one face fails", async () => {
    const fonts: FontSource = {
      load: vi.fn((face: string) => (face.startsWith("700") ? Promise.reject(new Error("font failed")) : Promise.resolve([]))),
      ready: Promise.resolve(),
    };
    const watcher = canvasFontWatcher(() => fonts, ["400 10px Mono", "700 10px Mono"]);
    const listener = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    watcher.subscribe(listener);
    await settle();

    expect(watcher.epoch()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("700 10px Mono");
    warn.mockRestore();
  });

  it("should keep the epoch when there is no font set to watch", () => {
    const watcher = canvasFontWatcher(() => undefined, ["400 10px Mono"]);

    watcher.subscribe(vi.fn());

    expect(watcher.epoch()).toBe(0);
  });
});
