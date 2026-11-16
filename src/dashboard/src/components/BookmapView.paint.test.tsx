// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { defaultLayout } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";

// The Order Flow heat key reads the cutoffs the canvas painted with.

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
});

const market = fromSnapshot(snapshotFixture(), 5, 0);

describe("BookmapView paint", () => {
  it("should print the high cutoff the painted heat used in the key when heat is in view", () => {
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const ticks = [...screen.getByRole("figure", { name: /^Heat scale/ }).querySelectorAll(".bookmap-heat-ticks span")].map((tick) => tick.textContent);

    expect(ticks).toHaveLength(2);
    expect(ticks[1]).not.toBe("—");
    expect(ticks[1]).toMatch(/^[\d,]+$/);
  });

  it("should print the same cutoffs whatever the contrast when the key reads the painted heat", () => {
    const ticksAt = (heatContrast: number) => {
      render(
        <BookmapView market={market} layout={{ ...defaultLayout, heatContrast }} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />,
      );
      const ticks = [...screen.getByRole("figure", { name: /^Heat scale/ }).querySelectorAll(".bookmap-heat-ticks span")].map((tick) => tick.textContent);
      cleanup();
      return ticks;
    };
    const plain = ticksAt(1);

    expect(plain[1]).toMatch(/^[\d,.]+$/);
    expect(ticksAt(0.5)).toEqual(plain);
    expect(ticksAt(2)).toEqual(plain);
  });
});
