import { HttpTransportType, HubConnectionBuilder } from "@microsoft/signalr";
import { afterEach, describe, expect, it } from "vitest";

import { clearApiKey, setApiKey, useApiKeyStorage } from "./apiKey.ts";
import { createMarketConnection, marketHubOptions, nextReconnectDelay, openMarketSubscription } from "./signalr.ts";

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

describe("market hub auth", () => {
  const store = storage();

  afterEach(() => {
    useApiKeyStorage(null);
    clearApiKey();
  });

  it("should return the stored key from the access token factory and not put it in the url", () => {
    useApiKeyStorage(store);
    setApiKey("synthetic-test-key");
    const options = marketHubOptions();
    const url = "http://localhost/hubs/market";

    expect(options.accessTokenFactory?.()).toBe("synthetic-test-key");
    expect(url).not.toContain("synthetic-test-key");
  });

  it("should return an empty token when no key is stored", () => {
    useApiKeyStorage(store);

    expect(marketHubOptions().accessTokenFactory?.()).toBe("");
  });

  it("should use a WebSocket and the same access token when the shell is native", () => {
    const options = marketHubOptions(() => "synthetic-test-key", true);

    expect(options.skipNegotiation).toBe(true);
    expect(options.transport).toBe(HttpTransportType.WebSockets);
    expect(options.accessTokenFactory?.()).toBe("synthetic-test-key");
  });

  it("should keep negotiation when the page is the browser", () => {
    const options = marketHubOptions(() => "synthetic-test-key", false);

    expect(options.skipNegotiation).toBeUndefined();
    expect(options.accessTokenFactory?.()).toBe("synthetic-test-key");
  });

  it("should set the indicator timeframe before taking the snapshot", async () => {
    const calls: string[] = [];

    const snapshot = await openMarketSubscription(
      async (method, ...args) => {
        calls.push(`${method}:${args.join(",")}`);
        return method === "Subscribe" ? { seq: 4 } : undefined;
      },
      "MES",
      240,
      15,
    );

    expect(calls).toEqual(["SetIndicatorTimeframe:MES,15", "Subscribe:MES,240"]);
    expect(snapshot).toEqual({ seq: 4 });
  });

  it("should stop reconnecting when the failure is a 401", () => {
    const delay = nextReconnectDelay({
      previousRetryCount: 2,
      elapsedMilliseconds: 1000,
      retryReason: new Error("Status code '401'"),
    });

    expect(delay).toBeNull();
  });

  it("should keep backing off when the failure is not a 401", () => {
    const delay = nextReconnectDelay({
      previousRetryCount: 0,
      elapsedMilliseconds: 0,
      retryReason: new Error("network down"),
    });

    expect(delay).toBe(500);
  });

  it("should build the connection with the hub url and the access token factory", () => {
    useApiKeyStorage(store);
    setApiKey("synthetic-test-key");
    const urls: string[] = [];
    const tokens: Array<string | Promise<string>> = [];
    const original = HubConnectionBuilder.prototype.withUrl;
    HubConnectionBuilder.prototype.withUrl = function withUrl(this: HubConnectionBuilder, url: string, options?: unknown) {
      urls.push(url);
      const factory = (options as { accessTokenFactory?: () => string | Promise<string> } | undefined)?.accessTokenFactory;
      if (factory) {
        tokens.push(factory());
      }
      return original.call(this, url, options as never);
    };

    try {
      createMarketConnection("http://localhost/hubs/market");
    } finally {
      HubConnectionBuilder.prototype.withUrl = original;
    }

    expect(urls).toEqual(["http://localhost/hubs/market"]);
    expect(tokens).toEqual(["synthetic-test-key"]);
  });
});
