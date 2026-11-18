import { describe, expect, it } from "vitest";

import { hints } from "./hints.ts";


describe("hints", () => {
  it("should hold one non-empty sentence per hinted control", () => {
    const entries = Object.entries(hints);

    // 16 since a separate change took the volume strip and CVD subchart toggles out of Display.
    expect(entries.length).toBeGreaterThanOrEqual(16);
    for (const [name, text] of entries) {
      expect(text.trim(), name).not.toBe("");
      expect(text.endsWith("."), name).toBe(true);
      expect(text.slice(0, -1).includes(". "), `${name} is more than one sentence`).toBe(false);
    }
  });

  it("should keep the hint texts distinct so no two controls explain themselves alike", () => {
    const texts = Object.values(hints);

    expect(new Set(texts).size).toBe(texts.length);
  });

  it("should say the PNC toggle shows the failed-reclaim markers and the trail guide, not the detected-event markers", () => {
    expect(hints.displayPnc).not.toContain("detected-event");
    expect(hints.displayPnc).toContain("failed-reclaim markers");
    expect(hints.displayPnc).toContain("trail guide");
    expect(hints.displayPnc).not.toContain("volume dot");
  });
});
