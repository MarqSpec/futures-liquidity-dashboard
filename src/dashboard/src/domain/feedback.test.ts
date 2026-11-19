import { describe, expect, it } from "vitest";

import { feedbackFixture, feedbackPosition, feedbackSpec, metricsFixture, replyFixture, statusFixture } from "../test/feedbackFixtures.ts";
import {
  citedValues,
  feedbackOffered,
  feedbackStatusSchema,
  planFeedbackReplySchema,
  staleReason,
  suggestionGhosts,
} from "./feedback.ts";
import { moveLine } from "./positionEdit.ts";

// reference: REQUIREMENTS.md FR-74, FR-72, NFR-8; INTERFACES.md D.1

describe("planFeedbackReplySchema", () => {
  it("should accept a reply with feedback", () => {
    expect(planFeedbackReplySchema.safeParse(replyFixture()).success).toBe(true);
  });

  it("should accept a metrics-only reply with its reason", () => {
    const parsed = planFeedbackReplySchema.safeParse(replyFixture({ feedback: null, reason: "timeout" }));
    expect(parsed.success).toBe(true);
  });

  it("should refuse a fill likelihood outside low, medium, high and unknown", () => {
    const bad = replyFixture({ feedback: feedbackFixture({ legs: [{ ...feedbackFixture().legs[0]!, fillLikelihood: "certain" as never }] }) });
    expect(planFeedbackReplySchema.safeParse(bad).success).toBe(false);
  });

  it("should refuse a provider other than claude or mock", () => {
    expect(planFeedbackReplySchema.safeParse({ ...replyFixture(), provider: "other" }).success).toBe(false);
  });
});

describe("feedbackOffered", () => {
  it("should offer feedback when it is available", () => {
    expect(feedbackOffered(feedbackStatusSchema.parse(statusFixture()))).toBe(true);
  });

  it("should offer feedback when only the month's budget is spent", () => {
    expect(feedbackOffered(statusFixture({ available: false, reason: "budget-exhausted" }))).toBe(true);
  });

  it.each(["disabled", "no-key"])("should hide feedback when it is unavailable for %s", (reason) => {
    expect(feedbackOffered(statusFixture({ available: false, reason }))).toBe(false);
  });

  it("should hide feedback when there is no status", () => {
    expect(feedbackOffered(null)).toBe(false);
  });
});

describe("staleReason", () => {
  const input = { requested: feedbackPosition, current: feedbackPosition, asOfLastTicks: 20004, atrTicks: 8, lastTicks: 20004 };

  it("should be fresh when nothing has moved", () => {
    expect(staleReason(input)).toBeNull();
  });

  it("should be stale when the position was edited", () => {
    expect(staleReason({ ...input, current: { ...feedbackPosition, stopTicks: 19991 } })).toBe("position-changed");
  });

  it("should stay fresh when the tracker only moves a placed plan from planned to working", () => {
    expect(staleReason({ ...input, current: { ...feedbackPosition, state: "working" } })).toBeNull();
    expect(staleReason({ ...input, requested: { ...feedbackPosition, state: "working" }, current: feedbackPosition })).toBeNull();
  });

  it("should be stale when the entry fills", () => {
    const filled = { ...feedbackPosition, state: "filled" as const, fill: { timeMs: 1_700_000_050_000, priceTicks: 20000, riskTicks: 10 } };
    expect(staleReason({ ...input, current: filled })).toBe("position-changed");
  });

  it("should be stale when an exit is recorded on a filled plan", () => {
    const fill = { timeMs: 1_700_000_050_000, priceTicks: 20000, riskTicks: 10 };
    const filled = { ...feedbackPosition, state: "filled" as const, fill };
    const exited = { ...filled, exits: [{ timeMs: 1_700_000_060_000, priceTicks: 20020, quantity: 1, kind: "target" as const }] };
    expect(staleReason({ ...input, requested: filled, current: exited })).toBe("position-changed");
  });

  it.each([
    ["side", { side: "short" as const }],
    ["type", { entryType: "market" as const, entryTicks: null }],
    ["quantity", { quantity: 3 }],
    ["entry", { entryTicks: 20001 }],
    ["stop", { stopTicks: 19991 }],
    ["a target", { targets: [{ priceTicks: 20021, quantity: 2 }] }],
    ["a target quantity", { targets: [{ priceTicks: 20020, quantity: 1 }] }],
  ])("should be stale when the %s is edited", (_name, change) => {
    expect(staleReason({ ...input, current: { ...feedbackPosition, ...change } })).toBe("position-changed");
  });

  it("should be stale when the position was cleared", () => {
    expect(staleReason({ ...input, current: null })).toBe("position-changed");
  });

  it("should stay fresh when the last price moved exactly one ATR", () => {
    expect(staleReason({ ...input, lastTicks: 20012 })).toBeNull();
  });

  it("should be stale when the last price moved more than one ATR up or down", () => {
    expect(staleReason({ ...input, lastTicks: 20013 })).toBe("price-moved");
    expect(staleReason({ ...input, lastTicks: 19995 })).toBe("price-moved");
  });

  it("should stay fresh when the ATR or a price is unknown", () => {
    expect(staleReason({ ...input, atrTicks: null, lastTicks: 30000 })).toBeNull();
    expect(staleReason({ ...input, lastTicks: null })).toBeNull();
    expect(staleReason({ ...input, asOfLastTicks: null, lastTicks: 30000 })).toBeNull();
  });
});

describe("citedValues", () => {
  const metrics = metricsFixture();
  const entry = { leg: "entry", index: null } as const;
  const value = (names: string[], leg: { leg: "entry" | "stop" | "target"; index: number | null } | null) =>
    Object.fromEntries(citedValues(names, metrics, leg, feedbackSpec).map((cited) => [cited.name, cited.value]));

  it("should read each leg metric from the leg it belongs to", () => {
    expect(value(["distanceTicks", "distanceAtr", "restingAhead.now", "restingAhead.coverage10m"], entry)).toEqual({
      distanceTicks: "-4 ticks",
      distanceAtr: "-0.50 ATR",
      "restingAhead.now": "340 bid",
      "restingAhead.coverage10m": "92%",
    });
  });

  it("should read the trade-through share and the 10 minute mean", () => {
    expect(value(["throughFrequency.60", "throughFrequency.240", "restingAhead.mean10m"], entry)).toEqual({
      "throughFrequency.60": "50% (29 of 58 bars)",
      "throughFrequency.240": "25% (60 of 240 bars)",
      "restingAhead.mean10m": "280.5 bid",
    });
  });

  it("should say unknown, with the reason, for a metric the server could not know", () => {
    expect(value(["restingAhead.now", "keyLevels"], { leg: "target", index: 0 })).toEqual({
      "restingAhead.now": "unknown (outside-covered-depth)",
      keyLevels: "unknown (level-unknown)",
    });
  });

  it("should read the plan's own metrics", () => {
    expect(value(["lastTicks", "atrTicks", "stopAtr", "rewardRisk", "statusCode"], null)).toEqual({
      lastTicks: "5001.00",
      atrTicks: "8 ticks",
      stopAtr: "1.25 ATR",
      rewardRisk: "target 1: 2.00 R",
      statusCode: "Live",
    });
  });

  it("should read a plan-wide cite on a risk from every leg that has the metric", () => {
    expect(value(["distanceTicks"], null).distanceTicks).toBe("entry -4 ticks, stop -14 ticks, target 1 16 ticks");
  });

  it("should list the key levels and the walls in the way", () => {
    expect(value(["keyLevels", "inTheWay"], entry)).toEqual({ keyLevels: "VWAP 5000.25 (+1 ticks)", inTheWay: "1 item: bid wall ×500 at 5000.50" });
  });

  it("should still list a name the metrics do not hold, rather than hide it", () => {
    expect(value(["flow.zones"], { leg: "stop", index: null })["flow.zones"]).toBe("unknown");
  });
});

describe("suggestionGhosts", () => {
  it("should make one ghost per suggestion, at its price, for the leg it is about", () => {
    const ghosts = suggestionGhosts(feedbackFixture(), feedbackSpec);
    expect(ghosts.map((ghost) => [ghost.line, ghost.priceTicks])).toEqual([
      [{ kind: "entry" }, 20002],
      [{ kind: "stop" }, 19994],
    ]);
    expect(ghosts[0]?.label).toBe("Suggested entry 5000.50");
  });

  it("should address a target by its index", () => {
    const feedback = feedbackFixture({ legs: [{ ...feedbackFixture().legs[2]!, suggestion: { priceTicks: 20030, why: "a wall" } }] });
    expect(suggestionGhosts(feedback, feedbackSpec)[0]?.line).toEqual({ kind: "target", index: 0 });
  });

  it("should draw none for a leg without a suggestion", () => {
    expect(suggestionGhosts(feedbackFixture({ legs: [feedbackFixture().legs[2]!] }), feedbackSpec)).toEqual([]);
  });
});

describe("applying a suggestion through the position edit path", () => {
  it("should refuse a stop suggestion that is not below a long's entry, with the reason", () => {
    const [ghost] = suggestionGhosts(feedbackFixture({ legs: [{ ...feedbackFixture().legs[1]!, suggestion: { priceTicks: 20005, why: "x" } }] }), feedbackSpec);
    const edit = moveLine(feedbackPosition, ghost!.line, ghost!.priceTicks);
    expect(edit).toEqual({ ok: false, reason: "the stop must be below the entry" });
  });

  it("should accept a valid suggestion as the new position", () => {
    const [ghost] = suggestionGhosts(feedbackFixture(), feedbackSpec);
    const edit = moveLine(feedbackPosition, ghost!.line, ghost!.priceTicks);
    expect(edit.ok && edit.position.entryTicks).toBe(20002);
  });
});
