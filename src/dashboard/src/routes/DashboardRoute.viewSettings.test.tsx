// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutSettings } from "../domain/layout.ts";
import { defaultLayout } from "../domain/layout.ts";
import { DashboardRoute } from "./DashboardRoute.tsx";

// REQUIREMENTS.md FR-2 acceptance: the display interval, the visible history and the indicator timeframe are independent,
// so pressing one control changes that one setting and no other. Written from the prd, not from the route's code.

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
    market: null,
    awaitingSnapshot: true,
    error: null,
    resyncs: 0,
    rejectedDeltas: 0,
    depthRoots: ["MES"],
    refusedRoots: [],
  }),
}));

/** Every control starts off its default, so a press that reset a sibling to its default would show. */
const startingLayout: LayoutSettings = {
  ...defaultLayout,
  instrument: "MES",
  chartMinutes: 5,
  historyMinutes: 1440,
  indicatorMinutes: 15,
  sliceSeconds: 5,
};

function mount() {
  harness.layout = { ...startingLayout };
  const router = createMemoryRouter([{ id: "dashboard", path: "/", Component: DashboardRoute, loader: () => [] }], {
    initialEntries: ["/?tab=detail"],
    hydrationData: { loaderData: { dashboard: [] } },
  });
  render(<RouterProvider router={router} />);
}

afterEach(() => {
  cleanup();
  harness.listeners.clear();
});

describe("DashboardRoute view settings", () => {
  beforeEach(() => globalThis.localStorage.clear());

  it.each([
    ["Bars", "2m", { chartMinutes: 2 }],
    ["Window", "1h", { historyMinutes: 60 }],
    ["EMA timeframe", "5m", { indicatorMinutes: 5 }],
  ] as const)("should change only the %s setting when its %s button is pressed", async (group, button, expected) => {
    const user = userEvent.setup();
    mount();

    await user.click(within(screen.getByRole("group", { name: group })).getByRole("button", { name: button }));

    expect(harness.layout).toEqual({ ...startingLayout, ...expected });
  });

  it("should keep every earlier choice when the three controls are pressed one after another", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(within(screen.getByRole("group", { name: "Bars" })).getByRole("button", { name: "15m" }));
    await user.click(within(screen.getByRole("group", { name: "Window" })).getByRole("button", { name: "30m" }));
    await user.click(within(screen.getByRole("group", { name: "EMA timeframe" })).getByRole("button", { name: "1m" }));

    expect(harness.layout).toEqual({ ...startingLayout, chartMinutes: 15, historyMinutes: 30, indicatorMinutes: 1 });
  });
});
