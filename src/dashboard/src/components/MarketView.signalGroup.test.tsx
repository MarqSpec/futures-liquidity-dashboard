// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Signal } from "../api/schemas.ts";
import * as format from "../domain/format.ts";
import { formatTickRange } from "../domain/format.ts";
import { defaultLayout } from "../domain/layout.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import type { ViewWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { MarketView } from "./MarketView.tsx";

// reference: REQUIREMENTS.md FR-82; ARCHITECTURE.md D-69

const base = fromSnapshot(snapshotFixture(), 5, 0);
const at = base.serverTimeMs - 60_000;
const near = base.prints.at(-1)?.priceTicks ?? 0;

/** A synthetic sweep and stacked imbalance one tick apart and 20 s apart: one group. */
const grouped: Signal[] = [
  { id: 70_001, kind: "LiquiditySweep", bias: "Bearish", timeMs: at, priceTicks: near, priceHighTicks: near + 1, strength: 0.7, label: "Offer sweep (inferred)", detail: "2 levels taken" },
  { id: 70_002, kind: "StackedImbalance", bias: "Bullish", timeMs: at + 20_000, priceTicks: near + 1, priceHighTicks: near + 3, strength: 0.5, label: "Stacked buy imbalance", detail: "3 ticks" },
];
const market: MarketState = { ...base, orderFlow: { ...base.orderFlow, signals: grouped } };
const initial: ViewWindow = { spanMs: 180_000, offsetMs: 0, priceZoom: 1 };
const noop = () => undefined;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width: 800, height: 400, x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, toJSON() { return {}; } } } as ResizeObserverEntry],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = (() => {
    const state: Record<string | symbol, unknown> = { fillStyle: "#000" };
    return new Proxy(state, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return () => ({ width: 12 });
        if (key === "createPattern") return () => null;
        return () => undefined;
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    });
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(cleanup);

function view(shown: MarketState = market) {
  return (
    <MarketView
      market={shown}
      layout={defaultLayout}
      viewWindow={initial}
      crosshair={createCrosshairStore()}
      onWindow={noop}
      onResetWindow={noop}
      onTogglePane={noop}
      onToggleKind={noop}
      onReading={noop}
    />
  );
}

function renderView() {
  return render(view());
}

function groupRow(): HTMLElement {
  const row = within(screen.getByRole("list", { name: "Signals, newest first" })).getAllByRole("listitem").find((item) => item.classList.contains("ld-signal--group"));
  if (!row) throw new Error("no group row");
  return row;
}

const bandLabel = () => document.querySelector(".chart-surface .group-band-label");

describe("MarketView signal groups", () => {
  it("should mark the group's price range on the chart while its row is hovered, and only then", async () => {
    renderView();
    expect(bandLabel()).toBeNull();

    await userEvent.hover(groupRow());
    expect(bandLabel()?.textContent).toMatch(/^Group /);

    await userEvent.unhover(groupRow());
    expect(bandLabel()).toBeNull();
  });

  it("should keep the mark after the pointer leaves when the group is selected, until it is cleared", async () => {
    renderView();
    const mark = within(groupRow()).getByRole("button", { name: "Mark on chart" });

    await userEvent.click(mark);
    await userEvent.unhover(groupRow());
    expect(bandLabel()?.textContent).toMatch(/^Group /);

    await userEvent.click(mark);
    await userEvent.unhover(groupRow());
    expect(bandLabel()).toBeNull();
  });

  it("should not carry a selected group's mark to another instrument", async () => {
    const { rerender } = renderView();
    await userEvent.click(within(groupRow()).getByRole("button", { name: "Mark on chart" }));
    await userEvent.unhover(groupRow());
    expect(bandLabel()).not.toBeNull();

    rerender(view({ ...market, root: `${market.root}X` }));

    expect(bandLabel()).toBeNull();
    expect(within(groupRow()).getByRole("button", { name: "Mark on chart" }).getAttribute("aria-pressed")).toBe("false");
  });

  // reference: review 5985119089 on a separate change a separate change
  describe("when the listed groups change", () => {
    let id = 80_000;
    const spec = market.instrument;
    const sweepAt = (ticks: number, timeMs: number): Signal => ({ id: id++, kind: "LiquiditySweep", bias: "Bearish", timeMs, priceTicks: ticks, priceHighTicks: ticks + 1, strength: 0.7, label: "Offer sweep (inferred)", detail: "2 levels taken" });
    const stackedAt = (ticks: number, timeMs: number): Signal => ({ id: id++, kind: "StackedImbalance", bias: "Bullish", timeMs, priceTicks: ticks, priceHighTicks: ticks + 2, strength: 0.5, label: "Stacked buy imbalance", detail: "3 ticks" });
    const icebergAt = (ticks: number, timeMs: number): Signal => ({ id: id++, kind: "Iceberg", bias: "Bullish", timeMs, priceTicks: ticks, priceHighTicks: ticks, strength: 0.6, label: "Inferred bid iceberg", detail: "20 traded against at most 5 shown", hiddenEstimate: 10 });
    const withSignals = (signals: Signal[]): MarketState => ({ ...base, orderFlow: { ...base.orderFlow, signals } });
    const groupRowAt = (low: number, high: number): HTMLElement => {
      const range = formatTickRange(low, high, spec);
      const row = within(screen.getByRole("list", { name: "Signals, newest first" }))
        .getAllByRole("listitem")
        .find((item) => item.classList.contains("ld-signal--group") && item.querySelector(".detail")?.textContent?.includes(`@ ${range} ·`));
      if (!row) throw new Error(`no group row at ${range}`);
      return row;
    };
    const markButton = (row: HTMLElement) => within(row).getByRole("button", { name: "Mark on chart" });

    it("should drop a selected group's mark when the group dissolves, and not bring it back when the group re-forms", async () => {
      const sweep = sweepAt(near, at);
      const stacked = stackedAt(near + 1, at + 20_000);
      const { rerender } = render(view(withSignals([sweep, stacked])));
      await userEvent.click(markButton(groupRowAt(near, near + 3)));
      expect(bandLabel()?.textContent).toContain(`Group ${formatTickRange(near, near + 3, spec)}`);

      rerender(view(withSignals([stacked])));
      expect(bandLabel()).toBeNull();

      rerender(view(withSignals([sweep, stacked])));
      expect(bandLabel()).toBeNull();
      expect(markButton(groupRowAt(near, near + 3)).getAttribute("aria-pressed")).toBe("false");
    });

    it("should keep a selected group pressed and mark its current range when an iceberg joins its first signal's cluster", async () => {
      const first = icebergAt(near, at);
      const sweep = sweepAt(near + 1, at + 10_000);
      const joining = icebergAt(near + 4, at + 20_000);
      const { rerender } = render(view(withSignals([first, sweep])));
      await userEvent.click(markButton(groupRowAt(near, near + 2)));
      await userEvent.unhover(groupRowAt(near, near + 2));

      rerender(view(withSignals([first, sweep, joining])));

      expect(markButton(groupRowAt(near, near + 4)).getAttribute("aria-pressed")).toBe("true");
      expect(bandLabel()?.textContent).toContain(`Group ${formatTickRange(near, near + 4, spec)}`);
    });

    it("should show the selected group again when a hovered group's row goes away under the pointer, and not revive the hover when it re-forms", async () => {
      const selected = [sweepAt(near, at), stackedAt(near + 1, at + 10_000)];
      const hovered = [sweepAt(near + 40, at + 20_000), stackedAt(near + 41, at + 30_000)];
      const { rerender } = render(view(withSignals([...selected, ...hovered])));
      await userEvent.click(markButton(groupRowAt(near, near + 3)));
      await userEvent.hover(groupRowAt(near + 40, near + 43));
      expect(bandLabel()?.textContent).toContain(`Group ${formatTickRange(near + 40, near + 43, spec)}`);

      rerender(view(withSignals([...selected, hovered[1]!])));
      expect(bandLabel()?.textContent).toContain(`Group ${formatTickRange(near, near + 3, spec)}`);

      rerender(view(withSignals([...selected, ...hovered])));
      expect(bandLabel()?.textContent).toContain(`Group ${formatTickRange(near, near + 3, spec)}`);
    });
  });

  // (criterion 3: an unchanged row is not re-rendered)
  describe("when a render changes no row", () => {
    const iceberg = (id: number, ticks: number, timeMs: number): Signal => ({ id, kind: "Iceberg", bias: "Bullish", timeMs, priceTicks: ticks, priceHighTicks: ticks, strength: 0.6, label: "Inferred bid iceberg", detail: "20 traded against at most 5 shown", hiddenEstimate: 10 });
    const clusterAt = at - 900_000;
    const signals: Signal[] = [iceberg(71_001, near + 300, clusterAt), iceberg(71_002, near + 301, clusterAt + 10_000), ...grouped];
    const withSignals = (list: Signal[]): MarketState => ({ ...base, orderFlow: { ...base.orderFlow, signals: list } });
    /** Whether any row formatted a time of the group's first member or the cluster's first member. */
    const formatted = (spy: { mock: { calls: unknown[][] } }, ms: number) => spy.mock.calls.some(([arg]) => arg === ms);

    it("should not re-render the group or the cluster row when a stream update carries no signal change", () => {
      const { rerender } = render(view(withSignals(signals)));
      const spy = vi.spyOn(format, "formatLocalTime");

      rerender(view({ ...withSignals(signals), serverTimeMs: base.serverTimeMs + 1_000 }));

      expect(formatted(spy, at)).toBe(false);
      expect(formatted(spy, clusterAt)).toBe(false);
      spy.mockRestore();
    });

    it("should not re-render the group or the cluster row when an unrelated signal arrives", () => {
      const { rerender } = render(view(withSignals(signals)));
      const spy = vi.spyOn(format, "formatLocalTime");
      const farAway = iceberg(71_003, near + 900, at + 30_000);

      rerender(view(withSignals([...signals, farAway])));

      expect(formatted(spy, farAway.timeMs)).toBe(true);
      expect(formatted(spy, at)).toBe(false);
      expect(formatted(spy, clusterAt)).toBe(false);
      spy.mockRestore();
    });

    // reference: review 5997974582 on a separate change a separate change (ids restart from 1 in each server process)
    it("should show the new signal, not the old row, when a reconnect snapshot reuses a listed id with another price and label", () => {
      const reused = (price: number, label: string): Signal => ({ id: 7, kind: "LiquiditySweep", bias: "Bearish", timeMs: at, priceTicks: price, priceHighTicks: price, strength: 0.7, label, detail: "2 levels taken" });
      const spec = base.instrument;
      const { rerender } = render(view(withSignals([reused(near + 500, "Old process sweep")])));
      const listText = () => screen.getByRole("list", { name: "Signals, newest first" }).textContent ?? "";
      expect(listText()).toContain("Old process sweep");

      rerender(view(withSignals([reused(near + 520, "New process sweep")])));

      expect(listText()).not.toContain("Old process sweep");
      expect(listText()).toContain("New process sweep");
      expect(listText()).toContain(formatTickRange(near + 520, near + 520, spec));
    });

    it("should re-render the cluster row when a signal joins it", () => {
      const { rerender } = render(view(withSignals(signals)));
      const spy = vi.spyOn(format, "formatLocalTime");

      rerender(view(withSignals([...signals, iceberg(71_004, near + 302, clusterAt + 20_000)])));

      expect(formatted(spy, clusterAt)).toBe(true);
      spy.mockRestore();
    });
  });
});
