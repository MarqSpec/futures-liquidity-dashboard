import type { FeedbackStatus, PlanFeedbackReply, PlanMetrics } from "../domain/feedback.ts";
import { positionSchema, type Position } from "../domain/position.ts";

// Synthetic replies in the shape of INTERFACES.md D.1; nothing here is real market or personal data.

export const feedbackSpec = { tickSize: 0.25, priceDecimals: 2 };

export const feedbackPosition: Position = positionSchema.parse({
  side: "long",
  entryType: "limit",
  entryTicks: 20000,
  quantity: 2,
  stopTicks: 19990,
  targets: [{ priceTicks: 20020, quantity: 2 }],
  contractId: "CON.F.US.MES.Z26",
  createdMs: 1_700_000_000_000,
});

const unknownFlow = { sessionDeltaAtPrice: null, partial: false, zones: null, unfinishedAuctions: null, signals: null, nearReason: null };

export function metricsFixture(over: Partial<PlanMetrics> = {}): PlanMetrics {
  return {
    definitionsVersion: 1,
    instrument: "MES",
    contractId: "CON.F.US.MES.Z26",
    asOfMs: 1_700_000_100_000,
    statusCode: "Live",
    lastTicks: 20004,
    atrTicks: 8,
    legs: [
      {
        leg: "entry",
        index: null,
        priceTicks: 20000,
        distanceTicks: -4,
        distanceAtr: -0.5,
        distanceReason: null,
        restingAhead: { side: "bid", now: 340, nowReason: null, mean10m: 280.5, mean10mReason: null, coverage10m: 0.92, partial: true },
        throughFrequency: [
          { bars: 60, direction: "below", known: 58, through: 29, share: 0.5, coverage: 0.97, partial: true },
          { bars: 240, direction: "below", known: 240, through: 60, share: 0.25, coverage: 1, partial: false },
        ],
        lastReachedMs: 1_700_000_040_000,
        inTheWay: { wallsKnown: true, items: [{ kind: "wall", side: "bid", priceTicks: 20002, priceHighTicks: 20002, size: 500, ageMs: 4000 }], itemsReason: null },
        keyLevels: [{ kind: "vwap", name: "VWAP", priceTicks: 20001, distanceTicks: 1 }],
        keyLevelsReason: null,
        flow: unknownFlow,
      },
      {
        leg: "stop",
        index: null,
        priceTicks: 19990,
        distanceTicks: -14,
        distanceAtr: -1.75,
        distanceReason: null,
        restingAhead: null,
        throughFrequency: [],
        lastReachedMs: null,
        inTheWay: { wallsKnown: true, items: [], itemsReason: null },
        keyLevels: [],
        keyLevelsReason: null,
        flow: unknownFlow,
      },
      {
        leg: "target",
        index: 0,
        priceTicks: 20020,
        distanceTicks: 16,
        distanceAtr: 2,
        distanceReason: null,
        restingAhead: { side: "ask", now: null, nowReason: "outside-covered-depth", mean10m: null, mean10mReason: "outside-covered-depth", coverage10m: 0, partial: true },
        throughFrequency: [],
        lastReachedMs: null,
        inTheWay: { wallsKnown: true, items: [], itemsReason: null },
        keyLevels: null,
        keyLevelsReason: "level-unknown",
        flow: unknownFlow,
      },
    ],
    rewardRisk: [{ index: 0, targetTicks: 20020, ratio: 2, reason: null }],
    stopAtr: 1.25,
    stopAtrReason: null,
    stopPlacement: { justInside: false, near: [], wallsKnown: true },
    marketSlippage: null,
    regimes: [{ timeframeSeconds: 300, trend: "Ranging", ready: true }],
    coverage: { profilePartialSinceMs: null, vwapPartial: false, flowPartial: false, missingSinceMs: null },
    ...over,
  };
}

export function feedbackFixture(over: Partial<NonNullable<PlanFeedbackReply["feedback"]>> = {}): NonNullable<PlanFeedbackReply["feedback"]> {
  return {
    summary: "A long limit near the bid with a two-to-one target.",
    legs: [
      {
        leg: "entry",
        index: null,
        fillLikelihood: "high",
        assessment: "The entry sits just under the last price with a bid resting ahead.",
        suggestion: { priceTicks: 20002, why: "a wall sits at 20002" },
        cites: ["distanceAtr", "restingAhead.now", "throughFrequency.60"],
      },
      {
        leg: "stop",
        index: null,
        fillLikelihood: "low",
        assessment: "The stop is well clear of the entry.",
        suggestion: { priceTicks: 19994, why: "tighter, still beyond the VWAP" },
        cites: ["stopAtr"],
      },
      {
        leg: "target",
        index: 0,
        fillLikelihood: "unknown",
        assessment: "Depth at the target is not covered.",
        suggestion: null,
        cites: ["restingAhead.now", "rewardRisk"],
      },
    ],
    risks: [{ text: "A thin book behind the entry.", cites: ["restingAhead.coverage10m", "distanceTicks"] }],
    asOfMs: 1_700_000_100_000,
    definitionsVersion: 1,
    droppedCites: 0,
    ...over,
  };
}

export function replyFixture(over: Partial<PlanFeedbackReply> = {}): PlanFeedbackReply {
  return { metrics: metricsFixture(), feedback: feedbackFixture(), reason: null, provider: "claude", model: "claude-opus-5-5", ...over };
}

export function statusFixture(over: Partial<FeedbackStatus> = {}): FeedbackStatus {
  return {
    available: true,
    reason: null,
    provider: "claude",
    model: "claude-opus-5-5",
    spentUsd: 12.5,
    budgetUsd: 100,
    month: "2026-11",
    resetsAtMs: Date.UTC(2026, 11, 1),
    ...over,
  };
}
