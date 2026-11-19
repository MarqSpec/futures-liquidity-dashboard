import { z } from "zod";

import { formatChicagoMinute, formatTicks, type TickSpec } from "./format.ts";
import type { Position } from "./position.ts";
import type { PositionLine } from "./positionEdit.ts";

// Position feedback on the wire and on screen (REQUIREMENTS.md FR-74, NFR-8; INTERFACES.md D.1). The text is
// advisory commentary on the FR-73 metrics beside it; nothing here places, changes or cancels an order (FR-6).

const nullableNumber = z.number().nullish();

const restingSchema = z.object({
  side: z.string(),
  now: nullableNumber,
  nowReason: z.string().nullish(),
  mean10m: nullableNumber,
  mean10mReason: z.string().nullish(),
  coverage10m: z.number(),
  partial: z.boolean(),
});

const throughSchema = z.object({
  bars: z.number(),
  direction: z.string(),
  known: z.number(),
  through: z.number(),
  share: nullableNumber,
  coverage: z.number(),
  partial: z.boolean(),
});

const wayItemSchema = z.object({
  kind: z.string(),
  side: z.string().nullish(),
  priceTicks: z.number(),
  priceHighTicks: z.number(),
  size: nullableNumber,
  ageMs: z.number(),
});

const nearLevelSchema = z.object({ kind: z.string(), name: z.string(), priceTicks: z.number(), distanceTicks: z.number() });

const flowSchema = z.object({
  sessionDeltaAtPrice: nullableNumber,
  partial: z.boolean(),
  zones: z.array(z.unknown()).nullish(),
  unfinishedAuctions: z.array(z.unknown()).nullish(),
  signals: z.array(z.unknown()).nullish(),
  nearReason: z.string().nullish(),
});

const legMetricsSchema = z.object({
  leg: z.enum(["entry", "stop", "target"]),
  index: z.number().int().nullish(),
  priceTicks: nullableNumber,
  distanceTicks: nullableNumber,
  distanceAtr: nullableNumber,
  distanceReason: z.string().nullish(),
  restingAhead: restingSchema.nullish(),
  throughFrequency: z.array(throughSchema),
  lastReachedMs: nullableNumber,
  inTheWay: z.object({ wallsKnown: z.boolean(), items: z.array(wayItemSchema).nullish(), itemsReason: z.string().nullish() }),
  keyLevels: z.array(nearLevelSchema).nullish(),
  keyLevelsReason: z.string().nullish(),
  flow: flowSchema,
});

/** The FR-73 metrics of a plan, as the feedback reply carries them: what each citation is checked against. */
export const planMetricsSchema = z.object({
  definitionsVersion: z.number().int(),
  instrument: z.string(),
  contractId: z.string(),
  asOfMs: z.number(),
  statusCode: z.string(),
  lastTicks: nullableNumber,
  atrTicks: nullableNumber,
  legs: z.array(legMetricsSchema),
  rewardRisk: z.array(z.object({ index: z.number().int(), targetTicks: z.number(), ratio: nullableNumber, reason: z.string().nullish() })),
  stopAtr: nullableNumber,
  stopAtrReason: z.string().nullish(),
  stopPlacement: z.object({ justInside: z.boolean(), near: z.array(nearLevelSchema), wallsKnown: z.boolean() }),
  marketSlippage: z
    .object({
      slippageTicks: nullableNumber,
      averageTicks: nullableNumber,
      touchTicks: nullableNumber,
      worstTicks: nullableNumber,
      levelsWalked: z.number(),
      reason: z.string().nullish(),
    })
    .nullish(),
  regimes: z.array(z.object({ timeframeSeconds: z.number(), trend: z.string(), ready: z.boolean() })),
  coverage: z.object({ profilePartialSinceMs: nullableNumber, vwapPartial: z.boolean(), flowPartial: z.boolean(), missingSinceMs: nullableNumber }),
});

export const fillLikelihoods = ["low", "medium", "high", "unknown"] as const;
export type FillLikelihood = (typeof fillLikelihoods)[number];

const legFeedbackSchema = z.object({
  leg: z.enum(["entry", "stop", "target"]),
  index: z.number().int().nullish(),
  fillLikelihood: z.enum(fillLikelihoods),
  assessment: z.string(),
  suggestion: z.object({ priceTicks: z.number().int(), why: z.string() }).nullish(),
  cites: z.array(z.string()),
});

const positionFeedbackSchema = z.object({
  summary: z.string(),
  legs: z.array(legFeedbackSchema),
  risks: z.array(z.object({ text: z.string(), cites: z.array(z.string()) })),
  asOfMs: z.number(),
  definitionsVersion: z.number().int(),
  droppedCites: z.number().int(),
});

/** `POST /api/plans/feedback/{instrument}`: the metrics always, the feedback when it could be written. */
export const planFeedbackReplySchema = z.object({
  metrics: planMetricsSchema,
  feedback: positionFeedbackSchema.nullable(),
  reason: z.string().nullable(),
  provider: z.enum(["claude", "mock"]),
  model: z.string(),
});

/** `GET /api/plans/feedback/status`, and the body of a 503 or a budget 429. It holds no key. */
export const feedbackStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  spentUsd: z.number(),
  budgetUsd: z.number(),
  month: z.string(),
  resetsAtMs: z.number(),
});

/** The body of a 429 that is a rate limit rather than the budget. */
export const feedbackRefusalSchema = z.object({ reason: z.string(), retryAfterSeconds: z.number().nullish() });

export type PlanMetrics = z.infer<typeof planMetricsSchema>;
export type PlanFeedbackReply = z.infer<typeof planFeedbackReplySchema>;
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type FeedbackRefusal = z.infer<typeof feedbackRefusalSchema>;
export type LegFeedback = z.infer<typeof legFeedbackSchema>;
export type PositionFeedback = z.infer<typeof positionFeedbackSchema>;

export const budgetExhausted = "budget-exhausted";

/** The advisory label, always shown with feedback (FR-74). */
export const advisoryText = "Advisory: model commentary on mechanical metrics. Not financial advice. Simulated position; nothing is sent to a broker.";

/**
 * Whether the Feedback button and panel exist at all. Only a status that says feedback is available, or that only the
 * month's budget is spent, offers them; no key, disabled, no grant (403) and no answer all hide them (the maintainer, 2026-11-18).
 */
export function feedbackOffered(status: FeedbackStatus | null): boolean {
  return status !== null && (status.available || status.reason === budgetExhausted);
}

export type StaleReason = "position-changed" | "price-moved";

export interface StaleInput {
  /** The position the feedback was asked about. */
  readonly requested: Position;
  readonly current: Position | null;
  /** The last price the metrics were measured at. */
  readonly asOfLastTicks: number | null | undefined;
  readonly atrTicks: number | null | undefined;
  readonly lastTicks: number | null;
}

/**
 * The plan as feedback is about it: side, type, quantity, entry, stop and targets, plus how it has filled (the fill and
 * each exit). The tracker's `state` and `createdMs` are bookkeeping: planned becoming working changes nothing the
 * feedback said (the maintainer), while a fill or an exit does.
 */
function planKey(position: Position): string {
  const { side, entryType, entryTicks, quantity, stopTicks, targets, fill, exits } = position;
  return JSON.stringify([side, entryType, entryTicks ?? null, quantity, stopTicks, targets, fill ?? null, exits]);
}

/** Why the feedback no longer describes the plan, or null while it does. It is never refreshed on its own. */
export function staleReason({ requested, current, asOfLastTicks, atrTicks, lastTicks }: StaleInput): StaleReason | null {
  if (current === null || planKey(current) !== planKey(requested)) return "position-changed";
  if (asOfLastTicks == null || atrTicks == null || lastTicks === null || atrTicks <= 0) return null;
  return Math.abs(lastTicks - asOfLastTicks) > atrTicks ? "price-moved" : null;
}

export const staleText: Record<StaleReason, string> = {
  "position-changed": "Stale: the position changed since this feedback.",
  "price-moved": "Stale: the last price has moved more than 1 ATR since this feedback.",
};

interface LegRef {
  readonly leg: "entry" | "stop" | "target";
  readonly index?: number | null;
}

/** A leg as the reader names it: "entry", "stop", "target 2". */
export function legName(leg: LegRef): string {
  return leg.leg === "target" ? `target ${(leg.index ?? 0) + 1}` : leg.leg;
}

/** The chart line a leg of the feedback is about. */
export function lineOf(leg: LegRef): PositionLine {
  return leg.leg === "target" ? { kind: "target", index: leg.index ?? 0 } : { kind: leg.leg };
}

/** A suggestion drawn on the chart as a dashed ghost line that one click applies. */
export interface FeedbackGhost {
  readonly key: string;
  readonly line: PositionLine;
  readonly priceTicks: number;
  readonly label: string;
}

/** The key of a leg's ghost, shared by the chart and the panel so Apply finds the ghost it belongs to. */
export function ghostKey(leg: LegRef): string {
  return `ghost-${legName(leg).replace(" ", "-")}`;
}

/** One ghost per suggestion in the feedback, at its price. */
export function suggestionGhosts(feedback: PositionFeedback, spec: TickSpec): readonly FeedbackGhost[] {
  return feedback.legs.flatMap((leg) =>
    leg.suggestion
      ? [
          {
            key: ghostKey(leg),
            line: lineOf(leg),
            priceTicks: leg.suggestion.priceTicks,
            label: `Suggested ${legName(leg)} ${formatTicks(leg.suggestion.priceTicks, spec)}`,
          },
        ]
      : [],
  );
}

/** A cited metric with its value from the same response. */
export interface CitedValue {
  readonly name: string;
  readonly value: string;
}

const unknownText = (reason?: string | null) => (reason ? `unknown (${reason})` : "unknown");
const num = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const ticks = (value: number) => `${num(value)} ticks`;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

type LegMetrics = PlanMetrics["legs"][number];

/** The value of a per-leg metric on one leg; null when that leg does not carry it (a stop has no resting size). */
function legValue(name: string, leg: LegMetrics, spec: TickSpec): string | null {
  const resting = leg.restingAhead;
  switch (name) {
    case "distanceTicks":
      return leg.distanceTicks == null ? unknownText(leg.distanceReason) : ticks(leg.distanceTicks);
    case "distanceAtr":
      return leg.distanceAtr == null ? unknownText(leg.distanceReason) : `${leg.distanceAtr.toFixed(2)} ATR`;
    case "restingAhead.now":
      return !resting ? null : resting.now == null ? unknownText(resting.nowReason) : `${num(resting.now)} ${resting.side}`;
    case "restingAhead.mean10m":
      return !resting ? null : resting.mean10m == null ? unknownText(resting.mean10mReason) : `${num(resting.mean10m)} ${resting.side}`;
    case "restingAhead.coverage10m":
      return resting ? percent(resting.coverage10m) : null;
    case "throughFrequency.60":
    case "throughFrequency.240": {
      const bars = Number(name.split(".")[1]);
      const window = leg.throughFrequency.find((item) => item.bars === bars);
      if (!window) return null;
      return window.share == null ? "unknown" : `${percent(window.share)} (${window.through} of ${window.known} bars)`;
    }
    case "lastReachedMs":
      return leg.lastReachedMs == null ? "not in the window" : `${formatChicagoMinute(leg.lastReachedMs)} CT`;
    case "inTheWay": {
      const way = leg.inTheWay;
      if (!way.items) return unknownText(way.itemsReason);
      const first = way.items[0];
      if (!first) return "nothing";
      const what = [first.side, first.kind, first.size == null ? "" : `×${first.size}`].filter(Boolean).join(" ");
      return `${count(way.items.length, "item")}: ${what} at ${formatTicks(first.priceTicks, spec)}`;
    }
    case "keyLevels":
      if (!leg.keyLevels) return unknownText(leg.keyLevelsReason);
      return leg.keyLevels.length === 0
        ? "none near"
        : leg.keyLevels.map((level) => `${level.name} ${formatTicks(level.priceTicks, spec)} (${level.distanceTicks >= 0 ? "+" : ""}${level.distanceTicks} ticks)`).join(", ");
    case "flow.sessionDeltaAtPrice":
      return leg.flow.sessionDeltaAtPrice == null ? "no trades there" : num(leg.flow.sessionDeltaAtPrice);
    case "flow.zones":
      return leg.flow.zones ? count(leg.flow.zones.length, "zone") : unknownText(leg.flow.nearReason);
    case "flow.unfinishedAuctions":
      return leg.flow.unfinishedAuctions ? count(leg.flow.unfinishedAuctions.length, "auction") : unknownText(leg.flow.nearReason);
    case "flow.signals":
      return leg.flow.signals ? count(leg.flow.signals.length, "signal") : unknownText(leg.flow.nearReason);
    default:
      return null;
  }
}

const legMetricNames: ReadonlySet<string> = new Set([
  "distanceTicks",
  "distanceAtr",
  "restingAhead.now",
  "restingAhead.mean10m",
  "restingAhead.coverage10m",
  "throughFrequency.60",
  "throughFrequency.240",
  "lastReachedMs",
  "inTheWay",
  "keyLevels",
  "flow.sessionDeltaAtPrice",
  "flow.zones",
  "flow.unfinishedAuctions",
  "flow.signals",
]);

function planValue(name: string, metrics: PlanMetrics, spec: TickSpec): string {
  switch (name) {
    case "lastTicks":
      return metrics.lastTicks == null ? "unknown" : formatTicks(metrics.lastTicks, spec);
    case "atrTicks":
      return metrics.atrTicks == null ? "unknown" : ticks(metrics.atrTicks);
    case "statusCode":
      return metrics.statusCode;
    case "rewardRisk":
      return metrics.rewardRisk.length === 0
        ? "no target"
        : metrics.rewardRisk.map((item) => `target ${item.index + 1}: ${item.ratio == null ? unknownText(item.reason) : `${item.ratio.toFixed(2)} R`}`).join(", ");
    case "stopAtr":
      return metrics.stopAtr == null ? unknownText(metrics.stopAtrReason) : `${metrics.stopAtr.toFixed(2)} ATR`;
    case "stopPlacement": {
      const placement = metrics.stopPlacement;
      if (placement.near.length === 0) return placement.justInside ? "just inside a level" : "clear of levels";
      return `${placement.justInside ? "just inside " : "near "}${placement.near.map((near) => near.name).join(", ")}`;
    }
    case "marketSlippage":
      if (!metrics.marketSlippage) return "not a market entry";
      return metrics.marketSlippage.slippageTicks == null ? unknownText(metrics.marketSlippage.reason) : ticks(metrics.marketSlippage.slippageTicks);
    case "regimes":
      return metrics.regimes.length === 0 ? "none" : metrics.regimes.map((regime) => `${regime.timeframeSeconds / 60} min ${regime.ready ? regime.trend : "warming up"}`).join(", ");
    case "coverage": {
      const coverage = metrics.coverage;
      const gaps = [coverage.vwapPartial && "VWAP", coverage.flowPartial && "flow", coverage.profilePartialSinceMs != null && "profile", coverage.missingSinceMs != null && "missing data"].filter(Boolean);
      return gaps.length === 0 ? "complete" : `partial: ${gaps.join(", ")}`;
    }
    default:
      return "unknown";
  }
}

/**
 * The values of the metrics a claim cites, read from the metrics of the same response so each claim can be checked.
 * A leg's claim reads its own leg; a risk, which names no leg, reads every leg that holds the metric.
 */
export function citedValues(names: readonly string[], metrics: PlanMetrics, leg: LegRef | null, spec: TickSpec): readonly CitedValue[] {
  return names.map((name) => {
    if (!legMetricNames.has(name)) return { name, value: planValue(name, metrics, spec) };
    if (leg) {
      const own = metrics.legs.find((item) => item.leg === leg.leg && (item.index ?? null) === (leg.index ?? null));
      return { name, value: (own && legValue(name, own, spec)) ?? "unknown" };
    }
    const each = metrics.legs.flatMap((item) => {
      const value = legValue(name, item, spec);
      return value === null ? [] : [`${legName(item)} ${value}`];
    });
    return { name, value: each.length === 0 ? "unknown" : each.join(", ") };
  });
}

/** What each reason for metrics only means to the reader. */
export const noFeedbackText: Readonly<Record<string, string>> = {
  refusal: "the model declined to comment on this plan",
  truncated: "the model's answer was cut off",
  "invalid-response": "the model's answer did not match the expected shape",
  timeout: "the model did not answer in time",
  "upstream-rate-limited": "the model service is rate limited right now",
  "upstream-error": "the model service had an error",
  "connection-error": "the model service could not be reached",
  "api-error": "the model service refused the request",
};
