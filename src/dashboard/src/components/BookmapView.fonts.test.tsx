// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { fontFamilies } from "../design/tokens.ts";
import { defaultLayout } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";

// The Order Flow canvas repaints once IBM Plex has loaded. One case per file: the app's font watcher starts once, on
// the first canvas that subscribes, so the stand-in font set must be in place before that first render.

/** Every column head the canvas painted, one per frame: how many times the main canvas was drawn. */
const heads: string[] = [];

beforeAll(() => {
  globalThis.ResizeObserver = class {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [
          {
            target,
            contentRect: { width: 900, height: 500, x: 0, y: 0, top: 0, left: 0, bottom: 500, right: 900, toJSON() { return {}; } },
          } as ResizeObserverEntry,
        ],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = (() => {
    const state: Record<string | symbol, unknown> = { fillStyle: "#000", strokeStyle: "#000", font: "10px sans-serif" };
    return new Proxy(state, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return () => ({ width: 12 });
        if (key === "createPattern") return () => null;
        return (...args: unknown[]) => {
          if (key === "fillText" && args[0] === "PRICE") heads.push(String(target.font));
        };
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    });
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  heads.length = 0;
  cleanup();
  Reflect.deleteProperty(document, "fonts");
});

const market = fromSnapshot(snapshotFixture(), 5, 0);

/** A stand-in `document.fonts` whose faces load when the test says so. */
function stubFonts(): { readonly loaded: string[]; readonly finish: () => Promise<void> } {
  const loaded: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      load: (face: string) => {
        loaded.push(face);
        return gate;
      },
      ready: gate,
    },
  });
  return {
    loaded,
    finish: async () => {
      release();
      await act(async () => {
        await gate;
        await Promise.resolve();
      });
    },
  };
}

describe("BookmapView fonts", () => {
  it("should paint again in IBM Plex when the canvas faces have loaded", async () => {
    const fonts = stubFonts();
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const before = heads.length;

    expect(before).toBeGreaterThan(0);
    expect(fonts.loaded.some((face) => face.endsWith(fontFamilies.mono))).toBe(true);
    await fonts.finish();
    expect(heads.length).toBeGreaterThan(before);
  });
});
