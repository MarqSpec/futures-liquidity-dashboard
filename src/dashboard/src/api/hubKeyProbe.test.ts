import { afterEach, describe, expect, it, vi } from "vitest";

import { hubKeyProbe } from "./hubKeyProbe.ts";

describe("hubKeyProbe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should not probe in the browser, where the hub already reports 401", () => {
    expect(hubKeyProbe(false)).toBeNull();
  });

  it("should treat a native 401 as a rejected key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 401 })),
    );
    const probe = hubKeyProbe(true);

    await expect(probe?.()).resolves.toBe(true);
  });
});
