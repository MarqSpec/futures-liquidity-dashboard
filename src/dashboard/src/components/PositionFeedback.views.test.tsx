// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { advisoryText } from "../domain/feedback.ts";
import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { positionSchema } from "../domain/position.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { feedbackFixture, metricsFixture, replyFixture, statusFixture } from "../test/feedbackFixtures.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";
import { MarketView } from "./MarketView.tsx";

// reference: REQUIREMENTS.md FR-74, FR-72, NFR-8;
// Feedback beside the chart in Detail and in Order Flow, with the network stubbed at fetch.

vi.mock("../hooks/useElementSize.ts", () => ({ useElementSize: () => ({ width: 800, height: 600 }) }));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

const market = fromSnapshot(snapshotFixture(), 5, 0);
const entry = market.liquidity.bestBid ?? 0;
const position = positionSchema.parse({
  side: "long",
  entryType: "limit",
  entryTicks: entry,
  quantity: 1,
  stopTicks: entry - 4,
  targets: [{ priceTicks: entry + 8, quantity: 1 }],
  contractId: market.instrument.contractId,
  createdMs: 1,
});
const withPosition: LayoutSettings = { ...defaultLayout, positions: { [market.root]: position } };

function answer(suggestedStop: number, provider: "claude" | "mock" = "claude") {
  const base = feedbackFixture();
  const metrics = metricsFixture({ lastTicks: market.prints.at(-1)?.priceTicks ?? entry });
  return replyFixture({
    provider,
    metrics,
    feedback: { ...base, legs: [{ ...base.legs[1]!, suggestion: { priceTicks: suggestedStop, why: "a test reason" } }] },
  });
}

function serve(status: Response, post: () => Response = () => Response.json(answer(entry - 2))) {
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async (url) => (url.endsWith("/status") ? status.clone() : post()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const views = {
  Detail: () => {
    function Harness() {
      const [layout, setLayout] = useState(withPosition);
      return (
        <MarketView
          market={market}
          layout={layout}
          viewWindow={{ spanMs: 180_000, offsetMs: 0, priceZoom: 1 }}
          crosshair={createCrosshairStore()}
          onWindow={() => undefined}
          onResetWindow={() => undefined}
          onTogglePane={() => undefined}
          onToggleKind={() => undefined}
          onReading={(change) => setLayout((current) => change(current))}
        />
      );
    }
    render(<Harness />);
  },
  "Order Flow": () => {
    function Harness() {
      const [layout, setLayout] = useState(withPosition);
      return <BookmapView market={market} layout={layout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={(change) => setLayout((current) => change(current))} />;
    }
    render(<Harness />);
  },
};

describe.each(Object.entries(views))("Position feedback in %s", (_name, mount) => {
  it("should offer a Feedback button when feedback is available", async () => {
    serve(Response.json(statusFixture()));
    mount();
    expect(await screen.findByRole("button", { name: "Feedback" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Position feedback" })).toBeNull();
  });

  it.each([
    ["no key", () => Response.json(statusFixture({ available: false, reason: "no-key" }))],
    ["disabled", () => Response.json(statusFixture({ available: false, reason: "disabled" }))],
    ["no request-feedback grant", () => new Response("", { status: 403 })],
  ])("should render no Feedback button and no panel with %s", async (_case, status) => {
    const mock = serve(status());
    mount();
    await waitFor(() => expect(mock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: /Feedback|Asking/ })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Position feedback" })).toBeNull();
    expect(screen.getAllByText(/^SIMULATED .*entry/).length).toBeGreaterThan(0);
  });

  it("should show the panel beside the chart, with the advisory label and a MOCK label for the mock provider", async () => {
    serve(Response.json(statusFixture({ provider: "mock" })), () => Response.json(answer(entry - 2, "mock")));
    mount();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Feedback" }));
    const panel = await screen.findByRole("complementary", { name: "Position feedback" });
    expect(panel.parentElement?.className).toContain("feedback-beside--open");
    expect(within(panel).getByText("MOCK")).toBeTruthy();
    expect(within(panel).getByRole("note").textContent).toBe(advisoryText);
  });

  it("should apply a suggested stop to the position from the panel", async () => {
    serve(Response.json(statusFixture()));
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Feedback" }));
    await user.click(await screen.findByRole("button", { name: /^Apply the suggested stop/ }));
    expect(screen.getByLabelText<HTMLInputElement>("Stop").value).toBe(((entry - 2) * 0.25).toFixed(2));
    expect(screen.getByText(/Stale: the position changed/)).toBeTruthy();
  });

  it("should refuse an invalid suggestion with the reason and leave the position alone", async () => {
    serve(Response.json(statusFixture()), () => Response.json(answer(entry + 3)));
    mount();
    const user = userEvent.setup();
    const before = (await screen.findByLabelText<HTMLInputElement>("Stop")).value;
    await user.click(await screen.findByRole("button", { name: "Feedback" }));
    await user.click(await screen.findByRole("button", { name: /^Apply the suggested stop/ }));
    expect(screen.getAllByText("Sprang back: the stop must be below the entry").length).toBeGreaterThan(0);
    expect(screen.getByLabelText<HTMLInputElement>("Stop").value).toBe(before);
  });

  it("should show over budget with the spend and cap, and keep the button", async () => {
    serve(Response.json(statusFixture()), () => Response.json(statusFixture({ available: false, reason: "budget-exhausted", spentUsd: 100.2 }), { status: 429 }));
    mount();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Feedback" }));
    const panel = await screen.findByRole("complementary", { name: "Position feedback" });
    expect(within(panel).getByRole("status").textContent).toContain("$100.20 spent of the $100.00 cap");
    expect(screen.getByRole("button", { name: "Feedback" })).toBeTruthy();
  });
});
