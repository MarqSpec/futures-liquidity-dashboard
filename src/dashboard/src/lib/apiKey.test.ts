import { afterEach, describe, expect, it } from "vitest";

import { clearApiKey, readApiKey, reportUnauthorized, setApiKey, subscribeUnauthorized, useApiKeyStorage } from "./apiKey.ts";

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
}

describe("api key store", () => {
  const store = memory();

  afterEach(() => {
    useApiKeyStorage(null);
    store.values.clear();
  });

  it("should keep a trimmed key in the given store when one is set", () => {
    useApiKeyStorage(store.storage);

    setApiKey("  synthetic-test-key  ");

    expect(readApiKey()).toBe("synthetic-test-key");
    expect([...store.values.values()]).toEqual(["synthetic-test-key"]);
  });

  it("should forget the key when it is cleared", () => {
    useApiKeyStorage(store.storage);
    setApiKey("synthetic-test-key");

    clearApiKey();

    expect(readApiKey()).toBeNull();
  });

  it("should not keep a blank key when one is submitted", () => {
    useApiKeyStorage(store.storage);

    setApiKey("   ");

    expect(readApiKey()).toBeNull();
  });

  it("should tell listeners when a call is rejected and stop when they unsubscribe", () => {
    const heard: string[] = [];
    const stop = subscribeUnauthorized(() => {
      heard.push("rejected");
    });

    reportUnauthorized();
    stop();
    reportUnauthorized();

    expect(heard).toEqual(["rejected"]);
  });
});
