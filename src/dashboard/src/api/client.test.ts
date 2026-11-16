import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, getInstruments, getLayout, LayoutConflictError, putLayout, viewerKeyRejected } from "./client.ts";
import { defaultLayout } from "../domain/layout.ts";
import { clearApiKey, setApiKey, subscribeUnauthorized, useApiKeyStorage } from "../lib/apiKey.ts";
import { useNativeHttp, type NativeHttpCall } from "../lib/httpTransport.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("api client key", () => {
  const store = storage();

  afterEach(() => {
    useApiKeyStorage(null);
    clearApiKey();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    useNativeHttp(null);
  });

  it("should send the stored key as X-Api-Key and not in the url when a key is set", async () => {
    useApiKeyStorage(store);
    setApiKey("synthetic-test-key");
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await getInstruments();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/instruments");
    expect(url).not.toContain("synthetic-test-key");
    expect(new Headers(init?.headers).get("X-Api-Key")).toBe("synthetic-test-key");
  });

  it("should send no key header when the viewer has not entered one", async () => {
    useApiKeyStorage(store);
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await getInstruments();

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has("X-Api-Key")).toBe(false);
  });

  it("should fail as unauthorized once and report it when the server answers 401", async () => {
    useApiKeyStorage(store);
    setApiKey("synthetic-bad-key");
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const heard: string[] = [];
    const stop = subscribeUnauthorized(() => {
      heard.push("401");
    });

    const error = await getInstruments().then(
      () => null,
      (caught: unknown) => caught,
    );
    stop();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ failure: "unauthorized" });
    expect(heard).toEqual(["401"]);
  });

  it("should not report unauthorized when the caller is probing access", async () => {
    useApiKeyStorage(store);
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const heard: string[] = [];
    const stop = subscribeUnauthorized(() => {
      heard.push("401");
    });

    await expect(getInstruments(undefined, { reportUnauthorized: false })).rejects.toMatchObject({ failure: "unauthorized" });
    stop();

    expect(heard).toEqual([]);
  });

  it("should send the stored key on layout get and put and not in the url", async () => {
    useApiKeyStorage(store);
    setApiKey("synthetic-test-key");
    const document = { saved: true, revision: 4, layout: defaultLayout };
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => Response.json(document));
    vi.stubGlobal("fetch", fetchMock);

    await getLayout();
    await putLayout({ revision: 4, layout: defaultLayout });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("/api/layouts/me");
      expect(url).not.toContain("synthetic-test-key");
      expect(new Headers(init?.headers).get("X-Api-Key")).toBe("synthetic-test-key");
    }
    const put = fetchMock.mock.calls[1]?.[1];
    expect(JSON.parse(String(put?.body))).toEqual({ revision: 4, layout: defaultLayout });
  });

  it("should put the chosen indicator pane in the layout body", async () => {
    const layout = { ...defaultLayout, indicatorPane: "rsi14" as const };
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ saved: true, revision: 5, layout }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await putLayout({ revision: 4, layout });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { layout: { indicatorPane: string } };
    expect(body.layout.indicatorPane).toBe("rsi14");
  });

  it("should return the stored layout when a put conflicts", async () => {
    const document = { saved: true, revision: 5, layout: { ...defaultLayout, instrument: "MCL" } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(document, { status: 409 })));

    const error = await putLayout({ revision: 4, layout: defaultLayout }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LayoutConflictError);
    if (error instanceof LayoutConflictError) {
      expect(error.message).toBe("The layout was saved from somewhere else.");
      expect(error.document.revision).toBe(5);
      expect(error.document.saved).toBe(true);
      expect(error.document.layout.instrument).toBe("MCL");
    }
  });

  it("should say the server has nothing saved when a conflict document is unsaved", async () => {
    const document = { saved: false, revision: 0, layout: defaultLayout };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(document, { status: 409 })));

    const error = await putLayout({ revision: 4, layout: defaultLayout }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LayoutConflictError);
    if (error instanceof LayoutConflictError) {
      expect(error.message).toBe("The server has no saved layout.");
      expect(error.document.saved).toBe(false);
      expect(error.document.revision).toBe(0);
    }
  });

  it("should reject a conflict answer that is not a layout document", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 409 })));

    await expect(putLayout({ revision: 4, layout: defaultLayout })).rejects.toMatchObject({ failure: "bad-response" });
  });

  it("should time out a layout save when the request ignores abort", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const pending = putLayout({ revision: 4, layout: defaultLayout });
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(8000);

    await expect(settled).resolves.toMatchObject({ failure: "timeout" });
  });

  it("should send an 8 s connect and read timeout when the shell saves a layout", async () => {
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    const document = { saved: true, revision: 4, layout: defaultLayout };
    const seen: { call: NativeHttpCall | null } = { call: null };
    useNativeHttp(async (call) => {
      seen.call = call;
      return { status: 200, data: document, headers: { "Content-Type": "application/json" } };
    });

    await putLayout({ revision: 4, layout: defaultLayout });

    expect(seen.call).toMatchObject({
      method: "PUT",
      connectTimeout: 8000,
      readTimeout: 8000,
      url: "/api/layouts/me",
    });
  });

  it("should treat one 401 as a rejected key and should not announce or retry it", async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const heard: string[] = [];
    const stop = subscribeUnauthorized(() => {
      heard.push("401");
    });

    await expect(viewerKeyRejected()).resolves.toBe(true);
    stop();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(heard).toEqual([]);
  });

  it("should not treat a successful read or a network failure as a rejected key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => Response.json([])),
    );
    await expect(viewerKeyRejected()).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => {
        throw new Error("down");
      }),
    );
    await expect(viewerKeyRejected()).resolves.toBe(false);
  });
});
