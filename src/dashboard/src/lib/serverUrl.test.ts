import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOW_CLEARTEXT_STORAGE_KEY,
  SERVER_BASE_STORAGE_KEY,
  activeServerEndpoint,
  hubUrlFor,
  isNativeShell,
  normalizeServerBase,
  readServerSettings,
  resolveServerEndpoint,
  saveServerSettings,
  type KeyValueStore,
} from "./serverUrl.ts";

function memoryStore(seed: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("normalizeServerBase", () => {
  it("should keep an https origin and drop a trailing slash when the URL is absolute", () => {
    expect(normalizeServerBase("  https://dashboard.example/app/  ", false)).toEqual({
      ok: true,
      apiBaseUrl: "https://dashboard.example/app",
    });
  });

  it("should keep the port when the URL names one", () => {
    expect(normalizeServerBase("https://192.168.1.20:8443", false)).toEqual({
      ok: true,
      apiBaseUrl: "https://192.168.1.20:8443",
    });
  });

  it("should refuse http when cleartext is off", () => {
    const result = normalizeServerBase("http://192.168.1.20:5080", false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cleartext/i);
  });

  it("should accept http when cleartext is on", () => {
    expect(normalizeServerBase("http://[::1]:5080/", true)).toEqual({
      ok: true,
      apiBaseUrl: "http://[::1]:5080",
    });
  });

  it("should accept http for localhost and a private address when cleartext is on", () => {
    expect(normalizeServerBase("http://localhost:5080", true)).toEqual({ ok: true, apiBaseUrl: "http://localhost:5080" });
    expect(normalizeServerBase("http://dev.localhost:5080", true)).toEqual({ ok: true, apiBaseUrl: "http://dev.localhost:5080" });
    expect(normalizeServerBase("http://10.0.0.8:5080", true)).toEqual({ ok: true, apiBaseUrl: "http://10.0.0.8:5080" });
    expect(normalizeServerBase("http://172.16.5.4:5080", true)).toEqual({ ok: true, apiBaseUrl: "http://172.16.5.4:5080" });
    expect(normalizeServerBase("http://192.168.1.20:5080", true)).toEqual({ ok: true, apiBaseUrl: "http://192.168.1.20:5080" });
    expect(normalizeServerBase("http://127.0.0.1:5080", true)).toEqual({ ok: true, apiBaseUrl: "http://127.0.0.1:5080" });
  });

  it("should refuse http for a public host even when cleartext is on", () => {
    const named = normalizeServerBase("http://dashboard.example:5080", true);
    const address = normalizeServerBase("http://8.8.8.8:5080", true);
    const outside = normalizeServerBase("http://172.32.0.1:5080", true);
    expect(named.ok).toBe(false);
    expect(address.ok).toBe(false);
    expect(outside.ok).toBe(false);
    if (!named.ok) expect(named.error).toMatch(/private/i);
  });

  it("should refuse a URL that is not absolute", () => {
    expect(normalizeServerBase("dashboard.example", true).ok).toBe(false);
  });

  it("should refuse a scheme other than http or https", () => {
    expect(normalizeServerBase("ftp://files.example", true).ok).toBe(false);
  });

  it("should refuse a username, password, query or hash", () => {
    expect(normalizeServerBase("https://user:secret@dashboard.example", true).ok).toBe(false);
    expect(normalizeServerBase("https://dashboard.example/app?x=1", true).ok).toBe(false);
    expect(normalizeServerBase("https://dashboard.example/app#panel", true).ok).toBe(false);
  });

  it("should refuse an empty value", () => {
    expect(normalizeServerBase("   ", true).ok).toBe(false);
  });
});

describe("resolveServerEndpoint", () => {
  it("should use the build-time base and ignore storage when the shell is the browser", () => {
    const resolved = resolveServerEndpoint({
      native: false,
      envBase: "https://build.example/",
      storedBase: "https://phone.example",
      allowCleartext: true,
    });

    expect(resolved).toEqual({
      native: false,
      configured: true,
      apiBaseUrl: "https://build.example",
      hubUrl: "https://build.example/hubs/market",
    });
  });

  it("should stay same-origin when the browser build has no base URL", () => {
    expect(resolveServerEndpoint({ native: false, envBase: "", storedBase: "https://phone.example", allowCleartext: false })).toEqual({
      native: false,
      configured: true,
      apiBaseUrl: "",
      hubUrl: "/hubs/market",
    });
  });

  it("should be unconfigured when the native shell has no stored URL", () => {
    const resolved = resolveServerEndpoint({ native: true, envBase: "", storedBase: null, allowCleartext: false });
    expect(resolved.configured).toBe(false);
    expect(resolved.apiBaseUrl).toBe("");
    expect(resolved.hubUrl).toBe("/hubs/market");
  });

  it("should use the stored https URL when the shell is native", () => {
    const resolved = resolveServerEndpoint({
      native: true,
      envBase: "",
      storedBase: "https://railway.example/",
      allowCleartext: false,
    });
    expect(resolved).toEqual({
      native: true,
      configured: true,
      apiBaseUrl: "https://railway.example",
      hubUrl: "https://railway.example/hubs/market",
    });
  });

  it("should stay unconfigured when the stored URL is http and cleartext is off", () => {
    const resolved = resolveServerEndpoint({
      native: true,
      envBase: "https://build.example",
      storedBase: "http://10.0.0.8:5080",
      allowCleartext: false,
    });
    expect(resolved.configured).toBe(false);
    expect(resolved.apiBaseUrl).toBe("");
  });

  it("should use an http URL when the shell is native and cleartext is on", () => {
    const resolved = resolveServerEndpoint({
      native: true,
      envBase: "",
      storedBase: "http://10.0.0.8:5080/",
      allowCleartext: true,
    });
    expect(resolved.apiBaseUrl).toBe("http://10.0.0.8:5080");
    expect(resolved.hubUrl).toBe("http://10.0.0.8:5080/hubs/market");
    expect(resolved.configured).toBe(true);
  });
});

describe("hubUrlFor", () => {
  it("should point at the market hub under the base", () => {
    expect(hubUrlFor("")).toBe("/hubs/market");
    expect(hubUrlFor("https://dashboard.example/app")).toBe("https://dashboard.example/app/hubs/market");
  });
});

describe("saveServerSettings", () => {
  it("should persist the normalized https URL and leave cleartext off", () => {
    const store = memoryStore();
    expect(saveServerSettings(store, "https://dashboard.example/app/", false)).toEqual({
      ok: true,
      apiBaseUrl: "https://dashboard.example/app",
    });
    expect(store.data[SERVER_BASE_STORAGE_KEY]).toBe("https://dashboard.example/app");
    expect(store.data[ALLOW_CLEARTEXT_STORAGE_KEY]).toBe("false");
    expect(readServerSettings(store)).toEqual({ base: "https://dashboard.example/app", allowCleartext: false });
  });

  it("should persist cleartext only when the viewer turned it on", () => {
    const store = memoryStore();
    expect(saveServerSettings(store, "http://10.0.0.8:5080", true).ok).toBe(true);
    expect(readServerSettings(store).allowCleartext).toBe(true);
  });

  it("should not write when the URL is refused", () => {
    const store = memoryStore({ [SERVER_BASE_STORAGE_KEY]: "https://kept.example" });
    const result = saveServerSettings(store, "http://10.0.0.8:5080", false);
    expect(result.ok).toBe(false);
    expect(store.data[SERVER_BASE_STORAGE_KEY]).toBe("https://kept.example");
  });

  it("should report failure when storage throws", () => {
    const store: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const result = saveServerSettings(store, "https://dashboard.example", false);
    expect(result.ok).toBe(false);
  });
});

describe("isNativeShell", () => {
  const previous = globalThis.Capacitor;

  afterEach(() => {
    if (previous === undefined) delete globalThis.Capacitor;
    else globalThis.Capacitor = previous;
  });

  it("should be false when Capacitor is absent", () => {
    delete globalThis.Capacitor;
    expect(isNativeShell()).toBe(false);
  });

  it("should follow Capacitor.isNativePlatform when it is present", () => {
    globalThis.Capacitor = { isNativePlatform: () => true };
    expect(isNativeShell()).toBe(true);
    globalThis.Capacitor = { isNativePlatform: () => false, getPlatform: () => "android" };
    expect(isNativeShell()).toBe(false);
  });

  it("should treat an android or ios platform as native when isNativePlatform is missing", () => {
    globalThis.Capacitor = { getPlatform: () => "android" };
    expect(isNativeShell()).toBe(true);
    globalThis.Capacitor = { getPlatform: () => "web" };
    expect(isNativeShell()).toBe(false);
  });
});

describe("activeServerEndpoint", () => {
  it("should read the browser default from the store it is given", () => {
    const store = memoryStore({ [SERVER_BASE_STORAGE_KEY]: "https://phone.example" });
    const resolved = activeServerEndpoint({ native: false, envBase: "", store });
    expect(resolved.apiBaseUrl).toBe("");
    expect(resolved.hubUrl).toBe("/hubs/market");
  });

  it("should read the stored URL when asked to resolve the native shell", () => {
    const store = memoryStore({
      [SERVER_BASE_STORAGE_KEY]: "https://phone.example/",
      [ALLOW_CLEARTEXT_STORAGE_KEY]: "false",
    });
    expect(activeServerEndpoint({ native: true, envBase: "", store }).apiBaseUrl).toBe("https://phone.example");
  });
});
