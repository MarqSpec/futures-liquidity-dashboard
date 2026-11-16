import { afterEach, describe, expect, it } from "vitest";

import { clearApiKey, readApiKey, setApiKey, useApiKeyStorage } from "./apiKey.ts";
import { afterProbe, settleAccess } from "./apiKeyAccess.ts";

function memory() {
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

describe("api key access", () => {
  afterEach(() => {
    useApiKeyStorage(null);
    clearApiKey();
  });

  it("should open when the probe succeeds and no key was sent", () => {
    expect(afterProbe(false, false, "ok")).toEqual({ action: "open" });
  });

  it("should ask for a key when the server rejects an anonymous caller", () => {
    expect(afterProbe(false, false, "unauthorized")).toEqual({ action: "prompt", reason: "missing" });
  });

  it("should drop a stored key and retry when the server rejects it", () => {
    expect(afterProbe(true, false, "unauthorized")).toEqual({ action: "drop-key-and-retry" });
  });

  it("should say the key was rejected when the viewer just submitted it", () => {
    expect(afterProbe(true, true, "unauthorized")).toEqual({ action: "prompt", reason: "rejected" });
  });

  it("should report unreachable when the probe cannot reach the API", () => {
    expect(afterProbe(false, false, "unreachable")).toEqual({ action: "unreachable" });
  });

  it("should open with no prompt when a stored key is rejected and the next probe is anonymous", async () => {
    useApiKeyStorage(memory());
    setApiKey("synthetic-stale-key");
    const probes: Array<string | null> = [];

    const settled = await settleAccess(null, async () => {
      probes.push(readApiKey());
      return probes.length === 1 ? "unauthorized" : "ok";
    });

    expect(settled).toEqual({ phase: "open" });
    expect(probes).toEqual(["synthetic-stale-key", null]);
    expect(readApiKey()).toBeNull();
  });

  it("should ask again when a key the viewer just typed is rejected", async () => {
    useApiKeyStorage(memory());

    const settled = await settleAccess("synthetic-bad-key", async () => "unauthorized");

    expect(settled).toEqual({ phase: "prompt", reason: "rejected" });
    expect(readApiKey()).toBeNull();
  });

  it("should keep the key when the probe accepts it", async () => {
    useApiKeyStorage(memory());

    const settled = await settleAccess("synthetic-test-key", async () => "ok");

    expect(settled).toEqual({ phase: "open" });
    expect(readApiKey()).toBe("synthetic-test-key");
  });
});
