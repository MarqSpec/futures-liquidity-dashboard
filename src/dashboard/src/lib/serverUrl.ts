import { config } from "../config.ts";

// reference: DEPLOYMENT.md
// reference: ARCHITECTURE.md D-31
// The browser build stays on config.apiBaseUrl (empty means same-origin). The Android shell is a different
// origin, so it uses the URL the viewer saved. HTTP is refused until they explicitly allow cleartext, and
// a public host is refused even then (localhost or RFC 1918 only).

export const SERVER_BASE_STORAGE_KEY = "fld.serverBaseUrl";
export const ALLOW_CLEARTEXT_STORAGE_KEY = "fld.allowCleartextHttp";

/** The bridge Capacitor injects into the WebView. Absent in a normal browser. */
export type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

declare global {
  var Capacitor: CapacitorBridge | undefined;
}

/** The storage the server URL uses. A private window or a full quota just fails the write. */
export type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type ServerEndpoint = {
  readonly apiBaseUrl: string;
  readonly hubUrl: string;
};

export type ServerResolution = ServerEndpoint & {
  readonly configured: boolean;
  readonly native: boolean;
};

export type NormalizeResult = { ok: true; apiBaseUrl: string } | { ok: false; error: string };

/** `localStorage`, or a store that fails closed when the page blocks it. */
export function browserStore(): KeyValueStore {
  return {
    getItem(key) {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      if (!globalThis.localStorage) {
        throw new Error("This browser has no local storage.");
      }
      globalThis.localStorage.setItem(key, value);
    },
  };
}

/** True inside the Capacitor Android (or iOS) WebView, false in the browser build. */
export function isNativeShell(): boolean {
  const bridge = globalThis.Capacitor;
  if (!bridge) {
    return false;
  }
  if (typeof bridge.isNativePlatform === "function") {
    return bridge.isNativePlatform();
  }
  const platform = bridge.getPlatform?.();
  return platform === "android" || platform === "ios";
}

/**
 * Loopback, or an RFC 1918 address. A public host is not a cleartext target even when the viewer opts in.
 * `hostname` is the URL host without brackets (`::1`, not `[::1]`).
 */
function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    return true;
  }
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const a = numbers[0];
  const b = numbers[1];
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return a === 172 && b >= 16 && b <= 31;
}

/** The market hub for an API base. An empty base is the same-origin path the browser uses today. */
export function hubUrlFor(apiBaseUrl: string): string {
  return `${apiBaseUrl}/hubs/market`;
}

/**
 * Turns a typed server URL into the base the client prefixes onto `/api` and `/hubs`.
 * HTTPS is accepted. HTTP is accepted only when `allowCleartext` is true.
 */
export function normalizeServerBase(raw: string, allowCleartext: boolean): NormalizeResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: "Enter the server URL." };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Enter an absolute URL, such as https://dashboard.example." };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "The URL must not contain a username or password." };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, error: "The URL must not contain a query or a hash." };
  }
  if (url.protocol === "http:") {
    if (!allowCleartext) {
      return { ok: false, error: "HTTP is cleartext. Turn on cleartext for a LAN or dev server, or use https." };
    }
    if (!isLoopbackOrPrivateHost(url.hostname)) {
      return { ok: false, error: "HTTP is only allowed for localhost or a private network address." };
    }
  } else if (url.protocol !== "https:") {
    return { ok: false, error: "Use an https URL." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.includes("//")) {
    return { ok: false, error: "The URL path is not valid." };
  }
  const apiBaseUrl = `${url.origin}${path}`;
  return { ok: true, apiBaseUrl };
}

/** The endpoint the page should call. The browser ignores anything saved for the shell. */
export function resolveServerEndpoint(input: {
  native: boolean;
  envBase: string;
  storedBase: string | null;
  allowCleartext: boolean;
}): ServerResolution {
  if (!input.native) {
    const apiBaseUrl = input.envBase.replace(/\/$/, "");
    return { native: false, configured: true, apiBaseUrl, hubUrl: hubUrlFor(apiBaseUrl) };
  }
  if (!input.storedBase) {
    return { native: true, configured: false, apiBaseUrl: "", hubUrl: hubUrlFor("") };
  }
  const parsed = normalizeServerBase(input.storedBase, input.allowCleartext);
  if (!parsed.ok) {
    return { native: true, configured: false, apiBaseUrl: "", hubUrl: hubUrlFor("") };
  }
  return { native: true, configured: true, apiBaseUrl: parsed.apiBaseUrl, hubUrl: hubUrlFor(parsed.apiBaseUrl) };
}

/** The URL and cleartext flag saved on this device. Missing storage reads as unset. */
export function readServerSettings(store: KeyValueStore): { base: string | null; allowCleartext: boolean } {
  try {
    const base = store.getItem(SERVER_BASE_STORAGE_KEY);
    const flag = store.getItem(ALLOW_CLEARTEXT_STORAGE_KEY);
    return {
      base: base !== null && base.trim() !== "" ? base : null,
      allowCleartext: flag === "true",
    };
  } catch {
    return { base: null, allowCleartext: false };
  }
}

/**
 * True when a successful save points at a different server than the one already stored.
 * A different origin or a cleartext flip must drop the viewer key before the reload, so the old key
 * is not sent to the new server.
 */
export function serverChangeDropsApiKey(
  previous: { readonly base: string | null; readonly allowCleartext: boolean },
  next: { readonly apiBaseUrl: string; readonly allowCleartext: boolean },
): boolean {
  return next.apiBaseUrl !== (previous.base ?? "") || next.allowCleartext !== previous.allowCleartext;
}

/** Saves a normalized URL. A refused URL leaves the previous value in place. */
export function saveServerSettings(store: KeyValueStore, rawBase: string, allowCleartext: boolean): NormalizeResult {
  const parsed = normalizeServerBase(rawBase, allowCleartext);
  if (!parsed.ok) {
    return parsed;
  }
  try {
    store.setItem(SERVER_BASE_STORAGE_KEY, parsed.apiBaseUrl);
    store.setItem(ALLOW_CLEARTEXT_STORAGE_KEY, allowCleartext ? "true" : "false");
  } catch {
    return { ok: false, error: "This browser could not store the server URL." };
  }
  return parsed;
}

/** The endpoint for this page: the build-time base in the browser, the saved URL in the shell. */
export function activeServerEndpoint(input?: { native?: boolean; envBase?: string; store?: KeyValueStore }): ServerResolution {
  const stored = readServerSettings(input?.store ?? browserStore());
  return resolveServerEndpoint({
    native: input?.native ?? isNativeShell(),
    envBase: input?.envBase ?? config.apiBaseUrl,
    storedBase: stored.base,
    allowCleartext: stored.allowCleartext,
  });
}

/** The API origin the HTTP client prefixes. Empty in the browser build. */
export function currentApiBaseUrl(): string {
  return activeServerEndpoint().apiBaseUrl;
}

/** The market hub URL. `/hubs/market` in the browser build. */
export function currentHubUrl(): string {
  return activeServerEndpoint().hubUrl;
}
