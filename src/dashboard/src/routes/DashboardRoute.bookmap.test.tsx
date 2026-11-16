// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutSettings } from "../domain/layout.ts";
import { defaultLayout } from "../domain/layout.ts";
import type { MarketState } from "../domain/merge.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { DashboardRoute } from "./DashboardRoute.tsx";

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
  market: null as MarketState | null,
}));

vi.mock("../api/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client.ts")>();
  return { ...actual, getInstruments: vi.fn(async () => []) };
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

vi.mock("../hooks/useMarketStream.ts", () => ({
  useMarketStream: () => ({
    hub: "connected" as const,
    market: harness.market,
    awaitingSnapshot: false,
    error: null,
    resyncs: 0,
    rejectedDeltas: 0,
    depthRoots: ["MES"],
    refusedRoots: [],
  }),
}));

// The route's loader result is handed to the router as hydration data, so the router starts initialized and the
// first render is synchronous: no `findByRole` races the cold first render of the whole dashboard against its
// one-second wait. Each behaviour is its own test, so the cold render is charged to a small test, not to one that
// also clicks through three states ().
// The loader returns no instruments.
function routerAt(entry: string) {
  return createMemoryRouter([{ id: "dashboard", path: "/", Component: DashboardRoute, loader: () => [] }], {
    initialEntries: [entry],
    hydrationData: { loaderData: { dashboard: [] } },
  });
}

function mountAt(entry: string) {
  harness.layout = { ...defaultLayout, instrument: "MES" };
  harness.market = { ...fromSnapshot(snapshotFixture(), 5, 0), root: "MES" };
  render(<RouterProvider router={routerAt(entry)} />);
}

afterEach(() => {
  cleanup();
  harness.listeners.clear();
});

describe("DashboardRoute order flow tab", () => {
  beforeEach(() => globalThis.localStorage.clear());

  it("should mount Order Flow from the old bookmap URL and keep the product panel collapsed", () => {
    mountAt("/?tab=bookmap");

    expect(screen.getByRole("tab", { name: "Order Flow: MES" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Order Flow MES" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Products" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Products/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("should expand the product panel and keep Order Flow mounted", async () => {
    const user = userEvent.setup();
    mountAt("/?tab=bookmap");

    await user.click(screen.getByRole("button", { name: /Products/ }));

    expect(screen.getByRole("button", { name: /Products/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "Order Flow MES" })).toBeTruthy();
  });

  it("should follow an instrument switch from the product panel and keep the product panel", async () => {
    const user = userEvent.setup();
    mountAt("/?tab=bookmap");

    await user.click(screen.getByRole("button", { name: /Products/ }));
    await user.click(screen.getByRole("button", { name: /^MES/ }));
    await user.click(screen.getByRole("button", { name: "Chart MCL" }));

    expect(screen.queryByRole("region", { name: "Order Flow MES" })).toBeNull();
    expect(screen.getByText("Loading the MCL snapshot…")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Products" })).toBeTruthy();
  });

  it("should open the same view from ?tab=orderflow", () => {
    mountAt("/?tab=orderflow");

    expect(screen.getByRole("tab", { name: "Order Flow: MES", selected: true })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Products" })).toBeTruthy();
  });
});
