// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutSettings } from "../domain/layout.ts";
import { defaultLayout } from "../domain/layout.ts";
import type { MarketConnection } from "../lib/signalr.ts";
import { instrumentsFixture, rawSnapshot } from "../test/fixtures.ts";
import { DashboardRoute } from "./DashboardRoute.tsx";

// REQUIREMENTS.md FR-57 acceptance: the Overview lists every enabled product and opening it adds no depth subscription.
// The server pulls depth for the roots the connection subscribed to and for its watchlist (SetWatchlist), so the hub
// is the place to look: the fake records every call the page makes. The product last open in Detail stays subscribed,
// so a page opened on the Overview subscribes to it and to nothing else (the maintainer's ruling, option A).
// Written from the prd, not from the route's code.

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
  hub: null as MarketConnection | null,
}));

vi.mock("../api/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client.ts")>();
  const fixtures = await import("../test/fixtures.ts");
  return { ...actual, getInstruments: vi.fn(async () => fixtures.instrumentsFixture()) };
});

vi.mock("../lib/signalr.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/signalr.ts")>();
  return { ...actual, createMarketConnection: () => harness.hub };
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

/** A hub that answers every call and counts it; it never pushes anything. */
function recordingHub(): MarketConnection {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => rawSnapshot),
    unsubscribe: vi.fn(async () => undefined),
    setWatchlist: vi.fn(async (roots: readonly string[]) => ({ depth: [...roots], refused: [] })),
    onDelta: () => undefined,
    onSnapshot: () => undefined,
    onState: (handler) => handler("connected", null),
    state: () => "connected",
  };
}

const hubCalls = (hub: MarketConnection) =>
  [hub.subscribe, hub.unsubscribe, hub.setWatchlist].map((call) => vi.mocked(call).mock.calls.length);

async function mountAt(entry: string) {
  harness.hub = recordingHub();
  const router = createMemoryRouter([{ id: "dashboard", path: "/", Component: DashboardRoute, loader: () => instrumentsFixture() }], {
    initialEntries: [entry],
    hydrationData: { loaderData: { dashboard: instrumentsFixture() } },
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return harness.hub;
}

afterEach(() => {
  cleanup();
  harness.listeners.clear();
});

describe("DashboardRoute overview", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    harness.layout = { ...defaultLayout, instrument: "CL", watchlist: ["ES"] };
  });

  // The Detail product the viewer last had open is off the watchlist on purpose. Opening the page on the Overview
  // may subscribe to it (the maintainer's ruling, option A) and to nothing else.
  it("should subscribe only to the remembered Detail product and watch only the watchlist when the page opens on the Overview", async () => {
    const hub = await mountAt("/?tab=overview");

    for (const root of ["ES", "CL", "GC"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^Open ${root} in Detail`) })).toBeTruthy();
    }
    expect(vi.mocked(hub.subscribe).mock.calls).toEqual([["CL", defaultLayout.historyMinutes, defaultLayout.indicatorMinutes]]);
    expect(vi.mocked(hub.setWatchlist).mock.calls).toEqual([[["ES"]]]);
  });

  it("should make no hub call at all when the viewer moves from Detail to the Overview", async () => {
    const user = userEvent.setup();
    const hub = await mountAt("/?tab=detail");
    const before = hubCalls(hub);
    expect(before).toEqual([1, 0, 1]);

    await user.click(screen.getByRole("tab", { name: "Overview" }));

    await act(async () => undefined);
    expect(screen.getByRole("button", { name: /^Open CL in Detail/ })).toBeTruthy();
    expect(hubCalls(hub)).toEqual(before);
  });
});
