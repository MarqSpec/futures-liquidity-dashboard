// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { canvasFontWatcher } from "../lib/canvasFonts.ts";
import { useCanvasFontEpoch } from "./useCanvasFontEpoch.ts";

// A canvas component re-renders, and so redraws, once the bundled fonts have loaded.

describe("useCanvasFontEpoch", () => {
  it("should re-render with the next epoch when the canvas fonts finish loading", async () => {
    let loaded = () => {};
    const ready = new Promise<void>((done) => {
      loaded = done;
    });
    const watcher = canvasFontWatcher(() => ({ load: () => ready, ready }), ["400 10px Mono"]);

    const { result } = renderHook(() => useCanvasFontEpoch(watcher));
    expect(result.current).toBe(0);
    await act(async () => {
      loaded();
      await ready;
    });

    expect(result.current).toBe(1);
  });
});
