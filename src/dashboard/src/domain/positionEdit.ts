import { maxPositionQuantity, maxPositionTargets, positionSchema, type Position, type PositionSide } from "./position.ts";
import { liveTargetIndices } from "./positionTrack.ts";

// Placing and editing the simulated position (REQUIREMENTS.md FR-72, ARCHITECTURE.md D-58). Every edit is checked against
// FR-72's rules before it is kept: a refused edit returns the rule it broke, and the chart and ticket spring back.

/** One line of the position on the chart. */
export type PositionLine = { readonly kind: "entry" } | { readonly kind: "fill" } | { readonly kind: "stop" } | { readonly kind: "target"; readonly index: number };

/** An edit FR-72 accepts, with the position it makes, or one it refuses, with the rule it broke. */
export type PositionEdit = { readonly ok: true; readonly position: Position } | { readonly ok: false; readonly reason: string };

/** A line as the chart draws it: where it is and what it says. */
export interface PositionLineView {
  readonly line: PositionLine;
  readonly priceTicks: number;
  readonly label: string;
  /** The line has done its work: the entry filled, the stop hit or the target filled. */
  readonly done: boolean;
}

const quantityRule = `the quantity must be a whole number from 1 to ${maxPositionQuantity}`;
const targetQuantityRule = `a target quantity must be a whole number from 1 to ${maxPositionQuantity}`;

function isQuantity(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maxPositionQuantity;
}

function refuse(reason: string): PositionEdit {
  return { ok: false, reason };
}

/** Checks a candidate against FR-72: the parsed position when it holds, otherwise the first rule it breaks. */
export function checkPosition(candidate: Position): PositionEdit {
  const parsed = positionSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, position: parsed.data };
  return refuse(parsed.error.issues[0]?.message ?? "the position is not valid");
}

const entryFilledRule = "the entry has filled: clear the position to start another";
const closedRule = "the position is closed: clear it to start another";

/** The refusal for an edit to what a filled position's entry fixed (side, type, quantity, entry), or null. */
function entryLocked(position: Position): PositionEdit | null {
  return position.state === "filled" || position.state === "closed" ? refuse(entryFilledRule) : null;
}

/** The refusal for an edit to the stop or a target of a closed position, or null. */
function exitsLocked(position: Position): PositionEdit | null {
  return position.state === "closed" ? refuse(closedRule) : null;
}

/** The refusal for moving a live target to or inside a target that has filled, which would reorder the scale-out, or null. */
function insideFilledTarget(position: Position, index: number, priceTicks: number): PositionEdit | null {
  if (position.state !== "filled") return null;
  const live = liveTargetIndices(position);
  const sign = position.side === "long" ? 1 : -1;
  const furthestFilled = position.targets.reduce(
    (best, target, at) => (live.includes(at) ? best : Math.max(best, sign * target.priceTicks)),
    Number.NEGATIVE_INFINITY,
  );
  return live.includes(index) && sign * priceTicks <= furthestFilled
    ? refuse(`target ${index + 1} must stay beyond the target that has filled`)
    : null;
}

/** The refusal for an edit to a target that has already filled, or null. */
function targetFilled(position: Position, index: number): PositionEdit | null {
  return position.state === "filled" && !liveTargetIndices(position).includes(index) ? refuse(`target ${index + 1} has filled`) : null;
}

/** The stop's default distance from the entry: a tenth of the visible price span, at least one tick. */
export function defaultStopDistance(spanTicks: number): number {
  return Math.max(1, Math.round(spanTicks / 10));
}

/** What an Alt-click needs to place a position. */
export interface PlaceInput {
  readonly priceTicks: number;
  readonly lastTicks: number | null;
  readonly spanTicks: number;
  readonly contractId: string;
  readonly nowMs: number;
}

/**
 * A limit entry at the clicked tick: a long at or below the last price (or with no last price), a short above it.
 * One contract, a stop a tenth of the visible span away and one target twice as far on the other side.
 */
export function placePosition({ priceTicks, lastTicks, spanTicks, contractId, nowMs }: PlaceInput): Position {
  const entry = Math.round(priceTicks);
  const side: PositionSide = lastTicks !== null && entry > lastTicks ? "short" : "long";
  const away = side === "long" ? 1 : -1;
  const distance = defaultStopDistance(spanTicks);
  return {
    side,
    entryType: "limit",
    entryTicks: entry,
    quantity: 1,
    stopTicks: entry - away * distance,
    targets: [{ priceTicks: entry + away * 2 * distance, quantity: 1 }],
    contractId,
    createdMs: Math.max(1, Math.round(nowMs)),
    state: "planned",
    fill: null,
    exits: [],
  };
}

/** The position with one line moved to the nearest tick of `priceTicks`, if FR-72 still holds. */
export function moveLine(position: Position, line: PositionLine, priceTicks: number): PositionEdit {
  const ticks = Math.round(priceTicks);
  switch (line.kind) {
    case "entry":
      {
    const refusal = entryLocked(position);
    if (refusal) return refusal;
  }
      if (position.entryTicks === null || position.entryTicks === undefined) return refuse("a market entry has no entry line");
      return checkPosition({ ...position, entryTicks: ticks });
    case "stop":
      return exitsLocked(position) ?? checkPosition({ ...position, stopTicks: ticks });
    case "fill":
      return refuse("the fill is where the entry filled");
    case "target":
      if (!position.targets[line.index]) return refuse(`there is no target ${line.index + 1}`);
      {
    const refusal = exitsLocked(position);
    if (refusal) return refusal;
  }
      {
    const refusal = targetFilled(position, line.index) ?? insideFilledTarget(position, line.index, ticks);
    if (refusal) return refusal;
  }
      return checkPosition({
        ...position,
        targets: position.targets.map((target, index) => (index === line.index ? { ...target, priceTicks: ticks } : target)),
      });
  }
}

/** The position on the other side, its stop and targets mirrored about the entry (about the stop with no entry). */
export function withSide(position: Position, side: PositionSide): PositionEdit {
  if (position.side === side) return { ok: true, position };
  {
    const refusal = entryLocked(position);
    if (refusal) return refusal;
  }
  const pivot = position.entryTicks ?? position.stopTicks;
  return checkPosition({
    ...position,
    side,
    stopTicks: 2 * pivot - position.stopTicks,
    targets: position.targets.map((target) => ({ ...target, priceTicks: 2 * pivot - target.priceTicks })),
  });
}

/**
 * The position as a limit or a market entry. A market entry drops its price, so it has no entry line. A limit takes
 * the last price when FR-72 allows it, else the tick midway between the stop and the nearest target.
 */
export function withEntryType(position: Position, entryType: Position["entryType"], lastTicks: number | null): PositionEdit {
  if (position.entryType === entryType) return { ok: true, position };
  {
    const refusal = entryLocked(position);
    if (refusal) return refusal;
  }
  if (entryType === "market") return checkPosition({ ...position, entryType, entryTicks: null });
  const nearest = [...position.targets].sort((a, b) => Math.abs(a.priceTicks - position.stopTicks) - Math.abs(b.priceTicks - position.stopTicks))[0];
  const away = position.side === "long" ? 1 : -1;
  const candidates = [
    position.entryTicks,
    lastTicks,
    nearest ? Math.round((position.stopTicks + nearest.priceTicks) / 2) : position.stopTicks + away,
  ].filter((ticks): ticks is number => ticks !== null && ticks !== undefined);
  let last: PositionEdit = refuse("a limit entry needs its price");
  for (const entryTicks of candidates) {
    last = checkPosition({ ...position, entryType, entryTicks });
    if (last.ok) return last;
  }
  return last;
}

/** The position with a new quantity, which must still cover its targets. */
export function withQuantity(position: Position, quantity: number): PositionEdit {
  if (!isQuantity(quantity)) return refuse(quantityRule);
  {
    const refusal = entryLocked(position);
    if (refusal) return refusal;
  }
  return checkPosition({ ...position, quantity });
}

/** The position with one target's quantity changed. */
export function withTargetQuantity(position: Position, index: number, quantity: number): PositionEdit {
  if (!position.targets[index]) return refuse(`there is no target ${index + 1}`);
  if (!isQuantity(quantity)) return refuse(targetQuantityRule);
  {
    const refusal = exitsLocked(position);
    if (refusal) return refusal;
  }
  {
    const refusal = targetFilled(position, index);
    if (refusal) return refusal;
  }
  return checkPosition({
    ...position,
    targets: position.targets.map((target, at) => (at === index ? { ...target, quantity } : target)),
  });
}

/** The position with one more target, a step beyond the furthest, for the contracts no target covers yet. */
export function addTarget(position: Position): PositionEdit {
  {
    const refusal = exitsLocked(position);
    if (refusal) return refusal;
  }
  if (position.targets.length >= maxPositionTargets) return refuse(`a position has at most ${maxPositionTargets} targets`);
  const left = position.quantity - position.targets.reduce((sum, target) => sum + target.quantity, 0);
  if (left < 1) return refuse("every contract already has a target: raise the quantity first");
  const away = position.side === "long" ? 1 : -1;
  const origin = position.entryTicks ?? position.stopTicks;
  const prices = [origin, ...position.targets.map((target) => target.priceTicks)];
  const furthest = prices.reduce((best, price) => (away * price > away * best ? price : best), origin);
  const previous = prices.filter((price) => price !== furthest).reduce((best, price) => (away * price > away * best ? price : best), origin);
  const step = Math.max(1, Math.abs(furthest - previous));
  return checkPosition({ ...position, targets: [...position.targets, { priceTicks: furthest + away * step, quantity: left }] });
}

/** The position without the target at `index`. */
export function removeTarget(position: Position, index: number): PositionEdit {
  if (!position.targets[index]) return refuse(`there is no target ${index + 1}`);
  {
    const refusal = exitsLocked(position);
    if (refusal) return refusal;
  }
  {
    const refusal = targetFilled(position, index);
    if (refusal) return refusal;
  }
  return checkPosition({ ...position, targets: position.targets.filter((_, at) => at !== index) });
}

/** The lines the chart draws: the entry (a limit, or a market entry that kept its price), the stop and each target. */
export function positionLines(position: Position): readonly PositionLineView[] {
  const lines: PositionLineView[] = [];
  const filled = position.fill ?? null;
  const unit = position.quantity > 1 ? ` ×${position.quantity}` : "";
  if (position.entryTicks !== null && position.entryTicks !== undefined) {
    const label = `SIMULATED ${position.side} entry ×${position.quantity}`;
    lines.push({ line: { kind: "entry" }, priceTicks: position.entryTicks, label: filled ? `${label} · filled` : label, done: filled !== null });
  }
  if (filled && (position.entryTicks === null || position.entryTicks === undefined)) {
    lines.push({ line: { kind: "fill" }, priceTicks: filled.priceTicks, label: `SIMULATED ${position.side} filled${unit}`, done: true });
  }
  const stop = position.exits.find((exit) => exit.kind === "stop");
  lines.push({ line: { kind: "stop" }, priceTicks: position.stopTicks, label: stop ? "SIMULATED stop · hit" : "SIMULATED stop", done: stop !== undefined });
  const live = liveTargetIndices(position);
  position.targets.forEach((target, index) => {
    const taken = position.state === "filled" || position.state === "closed" ? !live.includes(index) : false;
    const label = `SIMULATED target ${index + 1} ×${target.quantity}`;
    lines.push({ line: { kind: "target", index }, priceTicks: target.priceTicks, label: taken ? `${label} · filled` : label, done: taken });
  });
  return lines;
}

/** A stable key for a line. */
export function lineKey(line: PositionLine): string {
  return line.kind === "target" ? `target-${line.index}` : line.kind;
}
