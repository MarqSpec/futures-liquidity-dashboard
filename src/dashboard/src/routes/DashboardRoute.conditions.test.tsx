// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstrumentSummary } from "../api/schemas.ts";
import type { LayoutSettings } from "../domain/layout.ts";
import { defaultLayout } from "../domain/layout.ts";
import type { MarketConnection } from "../lib/signalr.ts";
import { instrumentSummaryFixture, rawSnapshot, regimeFixture } from "../test/fixtures.ts";
import { DashboardRoute } from "./DashboardRoute.tsx";

// REQUIREMENTS.md FR-81: Detail's regime rows are the selected product's FR-56 regimes from the polled list, never another row's.

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
    unobserve() {}
  },
);

const harness = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  layout: null as LayoutSettings | null,
  instruments: [] as InstrumentSummary[],
}));

vi.mock("../api/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client.ts")>();
  return { ...actual, getInstruments: vi.fn(async () => harness.instruments) };
});

/** A hub that answers the snapshot for ES, the synthetic snapshot's root, and never pushes anything. */
vi.mock("../lib/signalr.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/signalr.ts")>();
  const hub: MarketConnection = {
    start: async () => undefined,
    stop: async () => undefined,
    subscribe: async () => rawSnapshot,
    unsubscribe: async () => undefined,
    setWatchlist: async (roots: readonly string[]) => ({ depth: [...roots], refused: [] }),
    onDelta: () => undefined,
    onSnapshot: () => undefined,
    onState: (handler) => handler("connected", null),
    state: () => "connected",
  };
  return { ...actual, createMarketConnection: () => hub };
});

vi.mock("../hooks/useLayout.ts", () => ({
  useLayout: () => {
    const [, setTick] = useState(0);
    useEffect(() => {
      const notify = () => setTick((tick) => tick + 1);
      harness.listeners.add(notify);
      return () => {
        harness.listeners.delete(notify);
      };
    }, []);
    return {
      layout: harness.layout ?? defaultLayout,
      source: "browser" as const,
      update: (change: (current: LayoutSettings) => LayoutSettings) => {
        harness.layout = change(harness.layout ?? defaultLayout);
        harness.listeners.forEach((notify) => notify());
      },
    };
  },
}));

afterEach(() => {
  cleanup();
  harness.listeners.clear();
});

async function conditionReading(name: string): Promise<string> {
  const region = await screen.findByRole("region", { name: "Conditions" });
  const row = within(region)
    .getAllByRole("listitem")
    .find((element) => element.querySelector(".name")?.textContent === name);
  return row?.querySelector("[data-reading]")?.textContent ?? `no row ${name}`;
}

describe("DashboardRoute conditions", () => {
  it("should show the selected product's regimes on Detail's Conditions when the list serves another product first", async () => {
    globalThis.localStorage.clear();
    // CL is listed first with regimes the selected ES does not have, so a lookup that takes any other row shows them.
    harness.instruments = [
      instrumentSummaryFixture(
        { root: "CL", name: "Crude Oil", sector: "Energy" },
        { regimes: [regimeFixture(300, { trend: "TrendingDown" }), regimeFixture(900, { trend: "TrendingDown" })] },
      ),
      instrumentSummaryFixture(
        { root: "ES", name: "E-mini S&P 500" },
        { regimes: [regimeFixture(300, { trend: "Ranging" }), regimeFixture(900, { trend: "TrendingUp" })] },
      ),
    ];
    harness.layout = { ...defaultLayout, instrument: "ES", watchlist: [] };
    const router = createMemoryRouter([{ id: "dashboard", path: "/", Component: DashboardRoute, loader: () => harness.instruments }], {
      initialEntries: ["/?tab=detail"],
      hydrationData: { loaderData: { dashboard: harness.instruments } },
    });

    await act(async () => {
      render(<RouterProvider router={router} />);
    });

    expect(await conditionReading("5m regime")).toBe("ranging");
    expect(await conditionReading("15m regime")).toBe("trending up");
  });
});
