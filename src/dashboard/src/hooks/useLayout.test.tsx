// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { useLayout } from "./useLayout.ts";

const STORAGE_KEY = "futures-liquidity-dashboard.layout";
const SAVE_DELAY_MS = 600;
const WALL_MS = 1_700_000_000_000;

interface PutBody {
  readonly revision: number;
  readonly layout: LayoutSettings;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function putBody(body: unknown): PutBody {
  if (!body || typeof body !== "object" || !("revision" in body) || !("layout" in body)) {
    throw new Error("expected a layout put");
  }
  const revision = body.revision;
  const layout = body.layout;
  if (typeof revision !== "number" || !layout || typeof layout !== "object") {
    throw new Error("expected a layout put");
  }
  return { revision, layout: layout as LayoutSettings };
}

function installFetch(handler: (method: string, body: unknown) => Response | Promise<Response>): PutBody[] {
  const puts: PutBody[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
      if (method === "PUT") {
        puts.push(putBody(body));
      }
      return handler(method, body);
    }),
  );
  return puts;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function remember(revision: number, layout: LayoutSettings, pending = false): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ revision, layout, pending }));
}

/** A 200 whose body stays unread until `release`. The transport has already accepted the response, so a later abort still delivers it. */
function heldJsonResponse(body: unknown): { readonly response: Response; readonly release: () => void } {
  let open: (chunk: Uint8Array) => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      open = (chunk) => {
        controller.enqueue(chunk);
        controller.close();
      };
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } }),
    release: () => open(new TextEncoder().encode(JSON.stringify(body))),
  };
}

describe("useLayout", () => {
  it("should show the server layout when one is saved", async () => {
    vi.useFakeTimers();
    const puts = installFetch(() => jsonResponse({ saved: true, revision: 4, layout: { ...defaultLayout, instrument: "MGC" } }));

    const { result } = renderHook(() => useLayout());
    await advance(0);

    expect(result.current.source).toBe("server");
    expect(result.current.layout.instrument).toBe("MGC");
    expect(puts).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      revision: 4,
      pending: false,
      layout: { instrument: "MGC" },
    });
  });

  it("should put an unsent edit at the server revision when the page reloads", async () => {
    vi.useFakeTimers();
    remember(4, { ...defaultLayout, instrument: "MCL" }, true);
    const puts = installFetch((method, body) => {
      if (method === "PUT") {
        const sent = putBody(body);
        return jsonResponse({ saved: true, revision: sent.revision + 1, layout: sent.layout });
      }
      return jsonResponse({ saved: true, revision: 4, layout: defaultLayout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    await advance(SAVE_DELAY_MS);

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ revision: 4, layout: { instrument: "MCL" } });
    expect(result.current.source).toBe("server");
    expect(result.current.layout.instrument).toBe("MCL");
  });

  it("should put a valid local layout at revision zero when the server has nothing saved", async () => {
    vi.useFakeTimers({ now: WALL_MS });
    remember(12, { ...defaultLayout, instrument: "MCL" });
    const puts = installFetch((method, body) => {
      if (method === "PUT") {
        const sent = putBody(body);
        return jsonResponse({ saved: true, revision: 1, layout: sent.layout });
      }
      return jsonResponse({ saved: false, revision: 0, layout: defaultLayout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    await advance(SAVE_DELAY_MS);

    expect(puts).toEqual([expect.objectContaining({ revision: 0, layout: expect.objectContaining({ instrument: "MCL" }) })]);
    expect(puts[0]?.revision).not.toBe(Date.now());
    expect(result.current.layout.instrument).toBe("MCL");
    expect(result.current.source).toBe("server");
  });

  it("should keep the server layout when localStorage does not match the schema", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ revision: Number.MAX_SAFE_INTEGER, layout: { instrument: "not valid!!" } }),
    );
    const puts = installFetch(() => jsonResponse({ saved: true, revision: 4, layout: { ...defaultLayout, instrument: "MGC" } }));

    const { result } = renderHook(() => useLayout());
    await advance(SAVE_DELAY_MS);

    expect(result.current.layout.instrument).toBe("MGC");
    expect(result.current.source).toBe("server");
    expect(puts).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      revision: 4,
      pending: false,
      layout: { instrument: "MGC" },
    });
  });

  it("should not put the defaults when a corrupt local document is the only copy and the server has nothing saved", async () => {
    vi.useFakeTimers();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ revision: WALL_MS, layout: { instrument: "not valid!!" } }));
    const puts = installFetch(() => jsonResponse({ saved: false, revision: 0, layout: defaultLayout }));

    const { result } = renderHook(() => useLayout());
    await advance(SAVE_DELAY_MS);

    expect(puts).toEqual([]);
    expect(result.current.source).toBe("server");
    expect(result.current.layout.instrument).toBe("MES");
    expect(localStorage.getItem(STORAGE_KEY)).toContain("not valid");
  });

  it("should adopt the server layout and not retry when a put conflicts", async () => {
    vi.useFakeTimers();
    const puts = installFetch((method) => {
      if (method === "PUT") {
        return jsonResponse({ saved: true, revision: 8, layout: { ...defaultLayout, instrument: "MCL" } }, 409);
      }
      return jsonResponse({ saved: true, revision: 3, layout: defaultLayout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MGC" }));
    });
    await advance(SAVE_DELAY_MS);
    await advance(SAVE_DELAY_MS);

    expect(puts).toEqual([expect.objectContaining({ revision: 3, layout: expect.objectContaining({ instrument: "MGC" }) })]);
    expect(result.current.layout.instrument).toBe("MCL");
    expect(result.current.source).toBe("server");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      revision: 8,
      pending: false,
      layout: { instrument: "MCL" },
    });
  });

  it("should keep the edit in this browser when the conflict answer is not a layout", async () => {
    vi.useFakeTimers();
    const puts = installFetch((method) => (method === "PUT" ? new Response("nope", { status: 409 }) : jsonResponse({ saved: true, revision: 3, layout: defaultLayout })));

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MGC" }));
    });
    await advance(SAVE_DELAY_MS);

    expect(puts).toHaveLength(1);
    expect(result.current.layout.instrument).toBe("MGC");
    expect(result.current.source).toBe("browser");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({ revision: 3, pending: true });
  });

  it("should leave the edit in this browser when the put cannot reach the server", async () => {
    vi.useFakeTimers();
    const puts = installFetch((method) => (method === "PUT" ? jsonResponse({ message: "no" }, 500) : jsonResponse({ saved: true, revision: 2, layout: defaultLayout })));

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, historyMinutes: 60 }));
    });
    await advance(SAVE_DELAY_MS - 1);
    expect(puts).toEqual([]);
    await advance(1);
    await advance(SAVE_DELAY_MS);

    expect(puts).toEqual([expect.objectContaining({ revision: 2, layout: expect.objectContaining({ historyMinutes: 60 }) })]);
    expect(result.current.source).toBe("browser");
    expect(result.current.layout.historyMinutes).toBe(60);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({ revision: 2, pending: true });
  });

  it.each([
    ["the client clock lags by 60 seconds", -60_000],
    ["the client clock is exactly 60 seconds ahead", 60_000],
    ["the client clock is one millisecond past 60 seconds ahead", 60_001],
  ])("should send the server revision when %s", async (_label, skew) => {
    vi.useFakeTimers({ now: WALL_MS + skew });
    const puts = installFetch((method, body) => {
      if (method === "PUT") {
        const sent = putBody(body);
        return jsonResponse({ saved: true, revision: sent.revision + 1, layout: sent.layout });
      }
      return jsonResponse({ saved: true, revision: 4, layout: defaultLayout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MGC" }));
    });
    await advance(SAVE_DELAY_MS);

    expect(puts).toHaveLength(1);
    expect(puts[0]?.revision).toBe(4);
    expect(puts[0]?.revision).not.toBe(Date.now());
    expect(puts[0]?.layout.instrument).toBe("MGC");
  });

  it("should cite the unsaved server revision when an edit happens before the first read returns and the clock lags", async () => {
    vi.useFakeTimers({ now: WALL_MS - 60_000 });
    let releaseGet: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      releaseGet = resolve;
    });
    const puts = installFetch((method, body) => {
      if (method === "GET") {
        return pending;
      }
      const sent = putBody(body);
      return jsonResponse({ saved: true, revision: 1, layout: sent.layout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MGC" }));
    });
    releaseGet(jsonResponse({ saved: false, revision: 0, layout: defaultLayout }));
    await advance(0);
    await advance(SAVE_DELAY_MS);

    expect(puts).toHaveLength(1);
    expect(puts[0]?.revision).toBe(0);
    expect(puts[0]?.revision).not.toBe(Date.now());
    expect(puts[0]?.layout.instrument).toBe("MGC");
    expect(result.current.layout.instrument).toBe("MGC");
  });

  it("should keep the local layout and retry at revision zero when a put conflicts with an unsaved server", async () => {
    vi.useFakeTimers();
    const puts = installFetch((method, body) => {
      if (method === "PUT") {
        const sent = putBody(body);
        if (sent.revision === 0) {
          return jsonResponse({ saved: true, revision: 1, layout: sent.layout });
        }
        return jsonResponse({ saved: false, revision: 0, layout: defaultLayout }, 409);
      }
      return jsonResponse({ saved: true, revision: 4, layout: { ...defaultLayout, instrument: "MGC" } });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MCL" }));
    });
    await advance(SAVE_DELAY_MS);
    await advance(SAVE_DELAY_MS);

    expect(puts.map((put) => put.revision)).toEqual([4, 0]);
    expect(puts[1]?.layout.instrument).toBe("MCL");
    expect(result.current.layout.instrument).toBe("MCL");
    expect(result.current.source).toBe("server");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      revision: 1,
      pending: false,
      layout: { instrument: "MCL" },
    });
  });

  it("should keep a newer edit and cite the saved revision when a put in flight returns 200 after that edit", async () => {
    vi.useFakeTimers();
    let started = false;
    let releaseLate = (): void => {
      throw new Error("the first put did not start");
    };
    const server = { revision: 3, layout: { ...defaultLayout } };
    const puts = installFetch((method, body) => {
      if (method !== "PUT") {
        return jsonResponse({ saved: true, revision: server.revision, layout: server.layout });
      }
      const sent = putBody(body);
      if (!started) {
        started = true;
        const saved = { saved: true, revision: sent.revision + 1, layout: sent.layout };
        server.revision = saved.revision;
        server.layout = sent.layout;
        const held = heldJsonResponse(saved);
        releaseLate = held.release;
        return held.response;
      }
      if (sent.revision !== server.revision) {
        return jsonResponse({ saved: true, revision: server.revision, layout: server.layout }, 409);
      }
      server.revision += 1;
      server.layout = sent.layout;
      return jsonResponse({ saved: true, revision: server.revision, layout: server.layout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MGC" }));
    });
    await advance(SAVE_DELAY_MS);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MCL" }));
    });
    await act(async () => {
      releaseLate();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.layout.instrument).toBe("MCL");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      revision: 4,
      pending: true,
      layout: { instrument: "MCL" },
    });

    await advance(SAVE_DELAY_MS);

    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatchObject({ revision: 3, layout: { instrument: "MGC" } });
    expect(puts[1]).toMatchObject({ revision: 4, layout: { instrument: "MCL" } });
    expect(result.current.layout.instrument).toBe("MCL");
    expect(result.current.source).toBe("server");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      revision: 5,
      pending: false,
      layout: { instrument: "MCL" },
    });
  });

  it("should keep a newer edit when the put in flight is aborted and the follow-up echoes that save", async () => {
    vi.useFakeTimers();
    let holding = true;
    const server = { revision: 3, layout: { ...defaultLayout } };
    const puts = installFetch((method, body) => {
      if (method !== "PUT") {
        return jsonResponse({ saved: true, revision: server.revision, layout: server.layout });
      }
      const sent = putBody(body);
      if (holding) {
        holding = false;
        return new Promise<Response>(() => undefined);
      }
      if (sent.revision !== server.revision) {
        return jsonResponse({ saved: true, revision: server.revision, layout: server.layout }, 409);
      }
      server.revision += 1;
      server.layout = sent.layout;
      return jsonResponse({ saved: true, revision: server.revision, layout: server.layout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MGC" }));
    });
    await advance(SAVE_DELAY_MS);
    server.revision = 4;
    server.layout = { ...defaultLayout, instrument: "MGC" };
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MCL" }));
    });
    await advance(SAVE_DELAY_MS);
    await advance(SAVE_DELAY_MS);

    expect(puts[0]).toMatchObject({ revision: 3, layout: { instrument: "MGC" } });
    expect(puts.some((put) => put.revision === 4 && put.layout.instrument === "MCL")).toBe(true);
    expect(result.current.layout.instrument).toBe("MCL");
    expect(result.current.source).toBe("server");
  });

  it("should retry a newer edit when a conflict echoes this tab's earlier save", async () => {
    vi.useFakeTimers();
    let releaseFirst: () => void = () => undefined;
    let holding = true;
    const landed = { revision: 4, layout: { ...defaultLayout, instrument: "MGC" } };
    const puts = installFetch((method, body) => {
      if (method !== "PUT") {
        return jsonResponse({ saved: true, revision: 3, layout: defaultLayout });
      }
      const sent = putBody(body);
      if (holding) {
        holding = false;
        return new Promise<Response>((resolve) => {
          releaseFirst = () => resolve(jsonResponse({ saved: true, revision: landed.revision, layout: landed.layout }, 409));
        });
      }
      if (sent.revision !== landed.revision) {
        return jsonResponse({ saved: true, revision: landed.revision, layout: landed.layout }, 409);
      }
      return jsonResponse({ saved: true, revision: landed.revision + 1, layout: sent.layout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MGC" }));
    });
    await advance(SAVE_DELAY_MS);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MCL" }));
    });
    await act(async () => {
      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(SAVE_DELAY_MS);
    await advance(SAVE_DELAY_MS);

    expect(puts.some((put) => put.revision === 4 && put.layout.instrument === "MCL")).toBe(true);
    expect(result.current.layout.instrument).toBe("MCL");
    expect(result.current.layout.instrument).not.toBe("MGC");
  });

  it("should restore collapsed side sections when the page reloads", async () => {
    vi.useFakeTimers();
    const served = { ...defaultLayout, sideSectionsCollapsed: ["ladder", "layers"] };
    const puts = installFetch(() => jsonResponse({ saved: true, revision: 6, layout: served }));

    const { result } = renderHook(() => useLayout());
    await advance(0);

    expect(result.current.layout.sideSectionsCollapsed).toEqual(["ladder", "layers"]);
    expect(puts).toEqual([]);
    cleanup();

    const reloaded = renderHook(() => useLayout());
    expect(reloaded.result.current.layout.sideSectionsCollapsed).toEqual(["ladder", "layers"]);
    await advance(0);
    expect(reloaded.result.current.layout.sideSectionsCollapsed).toEqual(["ladder", "layers"]);
  });

  it("should put an unsent side-section collapse at the server revision when the page reloads", async () => {
    vi.useFakeTimers();
    remember(6, { ...defaultLayout, sideSectionsCollapsed: ["signals"] }, true);
    const puts = installFetch((method, body) => {
      if (method === "PUT") {
        const sent = putBody(body);
        return jsonResponse({ saved: true, revision: sent.revision + 1, layout: sent.layout });
      }
      return jsonResponse({ saved: true, revision: 6, layout: defaultLayout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    await advance(SAVE_DELAY_MS);

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ revision: 6, layout: { sideSectionsCollapsed: ["signals"] } });
    expect(result.current.layout.sideSectionsCollapsed).toEqual(["signals"]);
  });

  it("should retry reopening a side section made while its collapse was in flight when a conflict echoes that collapse", async () => {
    vi.useFakeTimers();
    let releaseFirst: () => void = () => undefined;
    let holding = true;
    const landed = { revision: 4, layout: { ...defaultLayout, sideSectionsCollapsed: ["levels"] } };
    const puts = installFetch((method, body) => {
      if (method !== "PUT") {
        return jsonResponse({ saved: true, revision: 3, layout: defaultLayout });
      }
      const sent = putBody(body);
      if (holding) {
        holding = false;
        return new Promise<Response>((resolve) => {
          releaseFirst = () => resolve(jsonResponse({ saved: true, revision: landed.revision, layout: landed.layout }, 409));
        });
      }
      if (sent.revision !== landed.revision) {
        return jsonResponse({ saved: true, revision: landed.revision, layout: landed.layout }, 409);
      }
      return jsonResponse({ saved: true, revision: landed.revision + 1, layout: sent.layout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, sideSectionsCollapsed: ["levels"] }));
    });
    await advance(SAVE_DELAY_MS);
    act(() => {
      result.current.update((layout) => ({ ...layout, sideSectionsCollapsed: [] }));
    });
    await act(async () => {
      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(SAVE_DELAY_MS);
    await advance(SAVE_DELAY_MS);

    expect(puts.some((put) => put.revision === 4 && put.layout.sideSectionsCollapsed.length === 0)).toBe(true);
    expect(result.current.layout.sideSectionsCollapsed).toEqual([]);
  });

  it("should restore a collapsed indicator dock when the page reloads", async () => {
    vi.useFakeTimers();
    const puts = installFetch(() => jsonResponse({ saved: true, revision: 6, layout: { ...defaultLayout, indicatorDockCollapsed: true } }));

    const { result } = renderHook(() => useLayout());
    await advance(0);

    expect(result.current.layout.indicatorDockCollapsed).toBe(true);
    expect(puts).toEqual([]);
    cleanup();

    const reloaded = renderHook(() => useLayout());
    expect(reloaded.result.current.layout.indicatorDockCollapsed).toBe(true);
    await advance(0);
    expect(reloaded.result.current.layout.indicatorDockCollapsed).toBe(true);
  });

  it("should put an unsent collapse at the server revision when the page reloads", async () => {
    vi.useFakeTimers();
    remember(6, { ...defaultLayout, indicatorDockCollapsed: true }, true);
    const puts = installFetch((method, body) => {
      if (method === "PUT") {
        const sent = putBody(body);
        return jsonResponse({ saved: true, revision: sent.revision + 1, layout: sent.layout });
      }
      return jsonResponse({ saved: true, revision: 6, layout: defaultLayout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    await advance(SAVE_DELAY_MS);

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ revision: 6, layout: { indicatorDockCollapsed: true } });
    expect(result.current.layout.indicatorDockCollapsed).toBe(true);
  });

  it("should retry an expand made while the collapse was in flight when a conflict echoes that collapse", async () => {
    vi.useFakeTimers();
    let releaseFirst: () => void = () => undefined;
    let holding = true;
    const landed = { revision: 4, layout: { ...defaultLayout, indicatorDockCollapsed: true } };
    const puts = installFetch((method, body) => {
      if (method !== "PUT") {
        return jsonResponse({ saved: true, revision: 3, layout: defaultLayout });
      }
      const sent = putBody(body);
      if (holding) {
        holding = false;
        return new Promise<Response>((resolve) => {
          releaseFirst = () => resolve(jsonResponse({ saved: true, revision: landed.revision, layout: landed.layout }, 409));
        });
      }
      if (sent.revision !== landed.revision) {
        return jsonResponse({ saved: true, revision: landed.revision, layout: landed.layout }, 409);
      }
      return jsonResponse({ saved: true, revision: landed.revision + 1, layout: sent.layout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, indicatorDockCollapsed: true }));
    });
    await advance(SAVE_DELAY_MS);
    act(() => {
      result.current.update((layout) => ({ ...layout, indicatorDockCollapsed: false }));
    });
    await act(async () => {
      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(SAVE_DELAY_MS);
    await advance(SAVE_DELAY_MS);

    expect(puts.some((put) => put.revision === 4 && !put.layout.indicatorDockCollapsed)).toBe(true);
    expect(result.current.layout.indicatorDockCollapsed).toBe(false);
  });

  it("should adopt another tab's save when a conflict returns an older layout at a newer revision", async () => {
    vi.useFakeTimers();
    const server = { revision: 2, layout: { ...defaultLayout, instrument: "MCL" } };
    const puts = installFetch((method, body) => {
      if (method !== "PUT") {
        return jsonResponse({ saved: true, revision: server.revision, layout: server.layout });
      }
      const sent = putBody(body);
      if (sent.layout.instrument === "MCL" && sent.revision === 4) {
        return jsonResponse({ saved: true, revision: 5, layout: { ...defaultLayout, instrument: "MES" } }, 409);
      }
      if (sent.revision !== server.revision) {
        return jsonResponse({ saved: true, revision: server.revision, layout: server.layout }, 409);
      }
      server.revision += 1;
      server.layout = sent.layout;
      return jsonResponse({ saved: true, revision: server.revision, layout: server.layout });
    });

    const { result } = renderHook(() => useLayout());
    await advance(0);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MES" }));
    });
    await advance(SAVE_DELAY_MS);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MGC" }));
    });
    await advance(SAVE_DELAY_MS);
    act(() => {
      result.current.update((layout) => ({ ...layout, instrument: "MCL" }));
    });
    await advance(SAVE_DELAY_MS);
    await advance(SAVE_DELAY_MS);

    expect(puts.map((put) => [put.revision, put.layout.instrument])).toEqual([
      [2, "MES"],
      [3, "MGC"],
      [4, "MCL"],
    ]);
    expect(result.current.layout.instrument).toBe("MES");
    expect(result.current.source).toBe("server");
  });
});
