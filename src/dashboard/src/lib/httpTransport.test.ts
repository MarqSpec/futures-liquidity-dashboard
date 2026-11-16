import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeadlineExceeded,
  buildNativeHttpCall,
  capacitorFetchIgnoresAbort,
  performHttp,
  settleWithin,
  useNativeHttp,
} from "./httpTransport.ts";

describe("capacitorFetchIgnoresAbort", () => {
  it("should ignore abort for a layout save and honor it for a read", () => {
    expect(capacitorFetchIgnoresAbort("PUT")).toBe(true);
    expect(capacitorFetchIgnoresAbort("post")).toBe(true);
    expect(capacitorFetchIgnoresAbort("GET")).toBe(false);
    expect(capacitorFetchIgnoresAbort("HEAD")).toBe(false);
  });
});

describe("buildNativeHttpCall", () => {
  it("should set the connect and read timeouts to the call's deadline", () => {
    const call = buildNativeHttpCall("https://lan.example/api/layouts/me", { method: "PUT", body: "{\"revision\":1}" }, { Accept: "application/json" }, 8000);

    expect(call).toMatchObject({
      url: "https://lan.example/api/layouts/me",
      method: "PUT",
      data: "{\"revision\":1}",
      connectTimeout: 8000,
      readTimeout: 8000,
    });
  });
});

describe("settleWithin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should reject at the deadline when the request never settles", async () => {
    vi.useFakeTimers();
    const pending = settleWithin(new Promise(() => undefined), 8000);
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(8000);

    await expect(settled).resolves.toBeInstanceOf(DeadlineExceeded);
  });

  it("should reject with the caller's abort when the request ignores the signal", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const pending = settleWithin(new Promise(() => undefined), 8000, caller.signal);
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    caller.abort();

    const error = await settled;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("should resolve when the request finishes inside the deadline", async () => {
    await expect(settleWithin(Promise.resolve("ok"), 8000)).resolves.toBe("ok");
  });
});

describe("performHttp", () => {
  afterEach(() => {
    useNativeHttp(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("should time out a native write that never returns and should send both timeouts", async () => {
    vi.useFakeTimers();
    const seen: { connectTimeout?: number; readTimeout?: number; method?: string } = {};
    useNativeHttp(
      (call) =>
        new Promise(() => {
          seen.connectTimeout = call.connectTimeout;
          seen.readTimeout = call.readTimeout;
          seen.method = call.method;
        }),
    );
    const pending = performHttp({
      url: "https://lan.example/api/layouts/me",
      init: { method: "PUT", body: "{}" },
      headers: { Accept: "application/json" },
      timeoutMs: 8000,
      native: true,
    });
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(8000);

    await expect(settled).resolves.toBeInstanceOf(DeadlineExceeded);
    expect(seen).toEqual({ connectTimeout: 8000, readTimeout: 8000, method: "PUT" });
  });

  it("should use fetch for a native read", async () => {
    const fetchMock = vi.fn(async () => new Response("[]"));
    vi.stubGlobal("fetch", fetchMock);
    useNativeHttp(async () => {
      throw new Error("native write");
    });

    const response = await performHttp({
      url: "/api/instruments",
      init: { method: "GET" },
      headers: {},
      timeoutMs: 8000,
      native: true,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
