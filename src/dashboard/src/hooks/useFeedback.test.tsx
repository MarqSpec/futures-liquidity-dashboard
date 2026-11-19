// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Position } from "../domain/position.ts";
import { trackPrint } from "../domain/positionTrack.ts";
import { feedbackPosition, feedbackSpec, replyFixture, statusFixture } from "../test/feedbackFixtures.ts";
import { useFeedback, type FeedbackInput } from "./useFeedback.ts";

// reference: REQUIREMENTS.md FR-74, FR-72;
// The network is stubbed at fetch; the hook and the client under it are real.

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function serve(handler: Handler) {
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async (url, init) => handler(url, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const posts = (mock: ReturnType<typeof serve>) => mock.mock.calls.filter(([, init]) => init?.method === "POST");

function routes(status: Response, post: () => Response | Promise<Response> = () => Response.json(replyFixture())): Handler {
  return (url) => (url.endsWith("/status") ? status.clone() : post());
}

function mount(over: Partial<FeedbackInput> = {}) {
  const apply = vi.fn();
  const view = renderHook((props: FeedbackInput) => useFeedback(props), {
    initialProps: { root: "MES", position: feedbackPosition as Position | null, lastTicks: 20004 as number | null, spec: feedbackSpec, apply, ...over },
  });
  return { ...view, apply };
}

function props(over: Partial<FeedbackInput>): FeedbackInput {
  return { root: "MES", position: feedbackPosition, lastTicks: 20004, spec: feedbackSpec, apply: vi.fn(), ...over };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useFeedback availability", () => {
  it("should offer feedback when the status says it is available", async () => {
    serve(routes(Response.json(statusFixture())));
    const { result } = mount();
    expect(result.current.offered).toBe(false);
    await waitFor(() => expect(result.current.offered).toBe(true));
  });

  it("should keep offering it when only the budget for the month is spent", async () => {
    serve(routes(Response.json(statusFixture({ available: false, reason: "budget-exhausted" }))));
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
  });

  it.each(["disabled", "no-key"])("should hide feedback when the status says %s", async (reason) => {
    const mock = serve(routes(Response.json(statusFixture({ available: false, reason }))));
    const { result } = mount();
    await waitFor(() => expect(mock).toHaveBeenCalled());
    await act(async () => undefined);
    expect(result.current.offered).toBe(false);
    expect(result.current.panel).toBeNull();
  });

  it("should hide feedback when the viewer lacks request-feedback (403)", async () => {
    const mock = serve(routes(new Response("", { status: 403 })));
    const { result } = mount();
    await waitFor(() => expect(mock).toHaveBeenCalled());
    await act(async () => undefined);
    expect(result.current.offered).toBe(false);
  });

  it("should hide feedback when the status cannot be read", async () => {
    const mock = serve(() => {
      throw new TypeError("offline");
    });
    const { result } = mount();
    await waitFor(() => expect(mock).toHaveBeenCalled());
    await act(async () => undefined);
    expect(result.current.offered).toBe(false);
  });
});

describe("useFeedback requests", () => {
  it("should ask once, disable while it is in flight, and show the reply", async () => {
    let release: (response: Response) => void = () => undefined;
    const mock = serve(routes(Response.json(statusFixture()), () => new Promise<Response>((resolve) => (release = resolve))));
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));

    act(() => result.current.request());
    expect(result.current.busy).toBe(true);
    expect(result.current.panel).toEqual({ kind: "loading" });
    act(() => result.current.request());
    expect(posts(mock)).toHaveLength(1);

    await act(async () => release(Response.json(replyFixture())));
    expect(result.current.busy).toBe(false);
    expect(result.current.panel?.kind).toBe("answered");
    expect(result.current.provider).toBe("claude");
    expect(result.current.ghosts.map((ghost) => ghost.key)).toEqual(["ghost-entry", "ghost-stop"]);
  });

  it("should not ask without a position", async () => {
    const mock = serve(routes(Response.json(statusFixture())));
    const { result } = mount({ position: null });
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.request());
    expect(posts(mock)).toHaveLength(0);
  });

  it("should show metrics only, with the reason, when the reply carries no feedback", async () => {
    serve(routes(Response.json(statusFixture()), () => Response.json(replyFixture({ feedback: null, reason: "timeout" }))));
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.panel?.kind).toBe("metrics-only"));
    expect(result.current.panel).toMatchObject({ reason: "timeout" });
    expect(result.current.ghosts).toEqual([]);
  });

  it("should show over budget with the status, and keep the button", async () => {
    const over = statusFixture({ available: false, reason: "budget-exhausted", spentUsd: 100 });
    serve(routes(Response.json(statusFixture()), () => Response.json(over, { status: 429 })));
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.panel?.kind).toBe("over-budget"));
    expect(result.current.offered).toBe(true);
  });

  it("should show rate limited", async () => {
    serve(routes(Response.json(statusFixture()), () => Response.json({ reason: "rate-limited", retryAfterSeconds: 9 }, { status: 429 })));
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.panel).toEqual({ kind: "rate-limited", reason: "rate-limited", retryAfterSeconds: 9 }));
  });

  it("should hide feedback again when the server says it went unavailable", async () => {
    serve(routes(Response.json(statusFixture()), () => Response.json(statusFixture({ available: false, reason: "no-key" }), { status: 503 })));
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.offered).toBe(false));
    expect(result.current.panel).toBeNull();
  });

  it("should show a failure when the call fails", async () => {
    serve(routes(Response.json(statusFixture()), () => new Response("", { status: 400 })));
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.panel).toEqual({ kind: "failed", message: "The server refused this position for feedback." }));
  });

  it("should close the panel", async () => {
    serve(routes(Response.json(statusFixture())));
    const { result } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.panel?.kind).toBe("answered"));
    act(() => result.current.close());
    expect(result.current.panel).toBeNull();
  });
});

describe("useFeedback staleness", () => {
  async function answered() {
    const mock = serve(routes(Response.json(statusFixture())));
    const view = mount();
    await waitFor(() => expect(view.result.current.offered).toBe(true));
    act(() => view.result.current.request());
    await waitFor(() => expect(view.result.current.panel?.kind).toBe("answered"));
    return { ...view, mock };
  }

  it("should stay fresh when the tracker takes a print that does not fill the entry", async () => {
    const { result, rerender } = await answered();
    const tracked = trackPrint(feedbackPosition, { priceTicks: 20001, sourceTimeMs: 1_700_000_100_500 });
    expect(tracked.state).toBe("working");
    rerender(props({ position: tracked }));
    expect(result.current.panel).toMatchObject({ kind: "answered", stale: null });
    expect(result.current.ghosts.length).toBe(2);
  });

  it("should go stale when the tracker takes a print that fills the entry", async () => {
    const { result, rerender } = await answered();
    const tracked = trackPrint(feedbackPosition, { priceTicks: 19999, sourceTimeMs: 1_700_000_100_500 });
    expect(tracked.state).toBe("filled");
    rerender(props({ position: tracked }));
    expect(result.current.panel).toMatchObject({ stale: "position-changed" });
  });

  it("should be fresh straight after the reply", async () => {
    const { result } = await answered();
    expect(result.current.panel).toMatchObject({ stale: null });
  });

  it("should go stale, drop its ghosts and not refresh when the position is edited", async () => {
    const { result, rerender, mock } = await answered();
    rerender(props({ position: { ...feedbackPosition, stopTicks: 19991 } }));
    expect(result.current.panel).toMatchObject({ kind: "answered", stale: "position-changed" });
    expect(result.current.ghosts).toEqual([]);
    expect(posts(mock)).toHaveLength(1);
  });

  it("should go stale when the last price moves more than one ATR, and not at exactly one", async () => {
    const { result, rerender } = await answered();
    rerender(props({ lastTicks: 20012 }));
    expect(result.current.panel).toMatchObject({ stale: null });
    rerender(props({ lastTicks: 20013 }));
    expect(result.current.panel).toMatchObject({ stale: "price-moved" });
  });

  it("should hide the reply while another product is on show", async () => {
    const { result, rerender } = await answered();
    rerender(props({ root: "MCL" }));
    expect(result.current.panel).toBeNull();
    rerender(props({ root: "MES" }));
    expect(result.current.panel?.kind).toBe("answered");
  });
});

describe("useFeedback product switch", () => {
  it("should leave no loading state or disabled button behind when the product switches away and back during a request", async () => {
    const mock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
      if (url.endsWith("/status")) return Response.json(statusFixture());
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    });
    vi.stubGlobal("fetch", mock);
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));

    act(() => result.current.request());
    expect(result.current.busy).toBe(true);
    rerender(props({ root: "MCL" }));
    rerender(props({ root: "MES" }));
    await waitFor(() => expect(result.current.offered).toBe(true));

    expect(result.current.busy).toBe(false);
    expect(result.current.panel).toBeNull();
    act(() => result.current.request());
    expect(result.current.busy).toBe(true);
    expect(posts(mock)).toHaveLength(2);
  });
});

describe("useFeedback applying a suggestion", () => {
  it("should send a valid suggestion through the position edit path", async () => {
    serve(routes(Response.json(statusFixture())));
    const { result, apply } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.ghosts.length).toBe(2));
    act(() => result.current.applyGhost(result.current.ghosts[1]!));
    const edit = apply.mock.calls[0]?.[0];
    expect(edit.ok && edit.position.stopTicks).toBe(19994);
  });

  it("should hand an invalid suggestion over as a refusal with its reason", async () => {
    const bad = replyFixture();
    bad.feedback!.legs[1]!.suggestion = { priceTicks: 20005, why: "x" };
    serve(routes(Response.json(statusFixture()), () => Response.json(bad)));
    const { result, apply } = mount();
    await waitFor(() => expect(result.current.offered).toBe(true));
    act(() => result.current.request());
    await waitFor(() => expect(result.current.ghosts.length).toBe(2));
    act(() => result.current.applyGhost(result.current.ghosts[1]!));
    expect(apply.mock.calls[0]?.[0]).toEqual({ ok: false, reason: "the stop must be below the entry" });
  });
});
