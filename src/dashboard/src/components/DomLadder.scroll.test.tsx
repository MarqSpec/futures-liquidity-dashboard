// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fromSnapshot } from "../domain/merge.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { DomLadder } from "./DomLadder.tsx";

const ROW = 20;
const BOX = 360;
const base = fromSnapshot(snapshotFixture(), 5, 0);

function book(askCount: number, bidCount: number) {
  return {
    ...base,
    ladder: {
      asks: Array.from({ length: askCount }, (_, i) => [1000 + i, 3] as [number, number]),
      bids: Array.from({ length: bidCount }, (_, i) => [999 - i, 4] as [number, number]),
    },
    liquidity: { ...base.liquidity, bestBid: 999, bestAsk: 1000, spreadTicks: 1, walls: [], endedWalls: [] },
  } as typeof base;
}

// jsdom has no layout: a row sits at its index * ROW, so the spread row is askCount rows down.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const rows = Array.from(this.parentElement?.children ?? []);
      return rows.indexOf(this) * ROW;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => ROW });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => BOX });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const centred = (asks: number) => asks * ROW + ROW / 2 - BOX / 2;
const box = () => screen.getByRole("region", { name: "Depth ladder levels" });
const show = (m: typeof base) => <DomLadder market={m} isKindOn={() => true} />;

describe("DomLadder following the inside", () => {
  it("should centre the spread row in the box when a deep book first renders", () => {
    render(show(book(100, 100)));

    expect(box().scrollTop).toBe(centred(100));
  });

  it("should keep the inside centred when ask rows are added above it", () => {
    const { rerender } = render(show(book(100, 100)));

    rerender(show(book(120, 100)));

    expect(box().scrollTop).toBe(centred(120));
  });

  it("should write the scroll position once per update when the inside moves", () => {
    const { rerender } = render(show(book(100, 100)));
    const writes = vi.fn();
    let top = box().scrollTop;
    Object.defineProperty(box(), "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        writes(v);
        top = v;
      },
    });

    rerender(show(book(110, 100)));
    rerender(show(book(110, 100)));

    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("should keep the Centre button disabled while following", () => {
    render(show(book(100, 100)));

    expect((screen.getByRole("button", { name: "Centre" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should not pause following when the browser anchors the scroll as rows are added above", () => {
    const { rerender } = render(show(book(100, 100)));
    box().scrollTop = centred(120);

    rerender(show(book(120, 100)));
    fireEvent.scroll(box());

    expect((screen.getByRole("button", { name: "Centre" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should pause following when the viewer scrolls the box", () => {
    const { rerender } = render(show(book(100, 100)));
    box().scrollTop = 40;
    fireEvent.scroll(box());

    rerender(show(book(120, 100)));

    expect(box().scrollTop).toBe(40);
    expect((screen.getByRole("button", { name: "Centre" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("should pause following when the viewer uses the wheel", async () => {
    const { rerender } = render(show(book(100, 100)));
    await userEvent.setup().pointer({ target: box() });
    fireEvent.wheel(box());

    rerender(show(book(120, 100)));

    expect(box().scrollTop).toBe(centred(100));
  });

  it("should not treat its own scroll write as the viewer's when the scroll event arrives", () => {
    render(show(book(100, 100)));

    fireEvent.scroll(box());

    expect((screen.getByRole("button", { name: "Centre" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should re-centre at once and resume following when Centre is pressed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(show(book(100, 100)));
    box().scrollTop = 40;
    fireEvent.scroll(box());
    rerender(show(book(120, 100)));

    await user.tab();
    await user.keyboard("{Enter}");

    expect(box().scrollTop).toBe(centred(120));
    rerender(show(book(130, 100)));
    expect(box().scrollTop).toBe(centred(130));
    expect((screen.getByRole("button", { name: "Centre" }) as HTMLButtonElement).disabled).toBe(true);
    expect(box()).toBe(document.activeElement);
  });

  it("should keep the inside centred when ask rows are removed above it", () => {
    const { rerender } = render(show(book(120, 100)));

    rerender(show(book(100, 100)));

    expect(box().scrollTop).toBe(centred(100));
  });

  it("should focus the ladder without scrolling the page when Centre is pressed", async () => {
    const user = userEvent.setup();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { rerender } = render(show(book(100, 100)));
    box().scrollTop = 40;
    fireEvent.scroll(box());
    rerender(show(book(120, 100)));
    focus.mockClear();

    await user.click(screen.getByRole("button", { name: "Centre" }));

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("should be reached with Tab so a keyboard scroll can pause following", async () => {
    const user = userEvent.setup();
    const { rerender } = render(show(book(100, 100)));

    await user.tab();
    expect(box()).toBe(document.activeElement);
    await user.keyboard("{ArrowDown}");
    box().scrollTop = 40;
    fireEvent.scroll(box());
    rerender(show(book(120, 100)));

    expect(box().scrollTop).toBe(40);
    expect((screen.getByRole("button", { name: "Centre" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("should pause at once on a navigation key, before the scroll event arrives", async () => {
    const user = userEvent.setup();
    const { rerender } = render(show(book(100, 100)));
    await user.tab();
    await user.keyboard("{PageDown}");

    rerender(show(book(120, 100)));

    expect(box().scrollTop).toBe(centred(100));
  });

  it("should pause at once on a pointer press in the box, before the scroll event arrives", () => {
    const { rerender } = render(show(book(100, 100)));
    fireEvent.pointerDown(box());

    rerender(show(book(120, 100)));

    expect(box().scrollTop).toBe(centred(100));
  });

  it("should never move the page when it centres", () => {
    const spy = vi.fn();
    vi.stubGlobal("scrollTo", spy);
    // jsdom has no scrollIntoView: define it for this test and remove it after.
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: spy });
    try {
      render(show(book(100, 100)));

      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});
