import { describe, expect, it } from "vitest";

import { endedWallTitle, outcomeLabel } from "./walls.ts";

const wall = { side: "Ask", priceTicks: 101, peakQuantity: 900, filled: 40, pulled: 860, stoodMs: 45_000, endedMs: 0, outcome: "Pulled" };

describe("outcomeLabel", () => {
  it("should say how the size left when the outcome is one the server defines", () => {
    expect(outcomeLabel("Filled")).toBe("mostly filled");
    expect(outcomeLabel("Pulled")).toBe("mostly pulled");
    expect(outcomeLabel("BelowThreshold")).toBe("below threshold");
  });

  it("should show the raw value when a newer server sends an outcome it does not know", () => {
    expect(outcomeLabel("Other")).toBe("Other");
  });
});

describe("endedWallTitle", () => {
  it("should give the peak and the split and no word of intent when a wall ended", () => {
    const title = endedWallTitle(wall);

    expect(title).toBe("ended ask wall, mostly pulled after 45.0 s: peak 900, 40 filled, 860 pulled");
    expect(title).not.toMatch(/spoof|intent|fake|manipulat/i);
  });

  // reference: review 5982800707: after price trades through, the marker can sit on the other side's row.
  it("should name the bid side when a bid wall ended", () => {
    expect(endedWallTitle({ ...wall, side: "Bid" })).toMatch(/^ended bid wall, /);
  });
});
