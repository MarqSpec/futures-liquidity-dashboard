import type { Position } from "./position.ts";

// Paper-tracking the simulated position against the live print stream (REQUIREMENTS.md FR-72, FR-4, FR-11; ARCHITECTURE.md
// D-59). A fill needs a print through the price, only live prints count, and it all runs in the browser.

/** The part of a print a fill needs. */
export interface TrackedPrint {
  readonly sourceTimeMs: number;
  readonly priceTicks: number;
}

type Exit = Position["exits"][number];

/** Whether the position still takes prints: it is not closed. */
export function isActive(position: Position): boolean {
  return position.state !== "closed";
}

function direction(position: Position): 1 | -1 {
  return position.side === "long" ? 1 : -1;
}

/** Contracts still open: the position's quantity less every exit. */
export function remainingQuantity(position: Position): number {
  return position.quantity - position.exits.reduce((sum, exit) => sum + exit.quantity, 0);
}

/** Target indices not yet filled, nearest the entry first. Targets fill nearest first, so the filled ones are a prefix. */
export function liveTargetIndices(position: Position): number[] {
  const sign = direction(position);
  const filled = position.exits.filter((exit) => exit.kind === "target").length;
  const price = (index: number) => position.targets[index]?.priceTicks ?? 0;
  return position.targets
    .map((_, index) => index)
    .sort((a, b) => sign * (price(a) - price(b)) || a - b)
    .slice(filled);
}

function enter(position: Position, print: TrackedPrint): Position {
  const sign = direction(position);
  const entry = position.entryTicks;
  let priceTicks: number | null = null;
  if (position.entryType === "market" || entry === null || entry === undefined) {
    priceTicks = print.priceTicks;
  } else if (sign * (entry - print.priceTicks) > 0) {
    // A limit fills only on a print strictly through its price, at that price.
    priceTicks = entry;
  }
  if (priceTicks === null) return position.state === "working" ? position : { ...position, state: "working" };
  // A market fill at or through the stop still has a basis: one tick, so R stays defined.
  const riskTicks = Math.max(1, Math.abs(priceTicks - position.stopTicks));
  return { ...position, state: "filled", fill: { timeMs: print.sourceTimeMs, priceTicks, riskTicks } };
}

function leave(position: Position, print: TrackedPrint): Position {
  const sign = direction(position);
  let left = remainingQuantity(position);
  const exits: Exit[] = [];
  if (sign * (print.priceTicks - position.stopTicks) <= 0) {
    // A stop fills like a stop-market: at the print, not at the stop's price.
    exits.push({ timeMs: print.sourceTimeMs, priceTicks: print.priceTicks, quantity: left, kind: "stop" });
    left = 0;
  } else {
    const live = liveTargetIndices(position);
    for (const [at, index] of live.entries()) {
      const target = position.targets[index];
      if (!target || left < 1 || sign * (print.priceTicks - target.priceTicks) <= 0) break;
      // The last target takes every contract no earlier target covered.
      const quantity = at === live.length - 1 ? left : Math.min(target.quantity, left);
      exits.push({ timeMs: print.sourceTimeMs, priceTicks: target.priceTicks, quantity, kind: "target" });
      left -= quantity;
    }
  }
  if (exits.length === 0) return position;
  return { ...position, state: left < 1 ? "closed" : "filled", exits: [...position.exits, ...exits] };
}

/** The position after one live print. A print that fills the entry is not also an exit. */
export function trackPrint(position: Position, print: TrackedPrint): Position {
  if (position.state === "closed") return position;
  if (position.state === "filled") return leave(position, print);
  return enter(position, print);
}

/** The position after prints in the order they came. */
export function trackPrints(position: Position, prints: readonly TrackedPrint[]): Position {
  return prints.reduce(trackPrint, position);
}

/** Ticks summed over contracts, so `currency` is `ticks` times the tick value, and R in units of entry-to-stop risk. */
export interface PnlAmount {
  readonly ticks: number;
  readonly currency: number;
  readonly r: number | null;
}

export interface PnlLeg extends PnlAmount {
  readonly kind: Exit["kind"];
  readonly quantity: number;
  /** Ticks per contract. */
  readonly legTicks: number;
}

export interface PositionPnl {
  readonly legs: readonly PnlLeg[];
  readonly realized: PnlAmount;
  /** The open contracts marked to the last price; null when none are open or there is no last price. */
  readonly open: PnlAmount | null;
  readonly total: PnlAmount;
}

/** P&L of a filled position: per leg, realized, open (marked to `markTicks`) and in total. Null before the fill. */
export function positionPnl(position: Position, tickValue: number, markTicks: number | null): PositionPnl | null {
  const fill = position.fill;
  if (!fill) return null;
  const sign = direction(position);
  // R is fixed at the fill: moving the stop afterwards does not rescale the legs already taken (D-59).
  const risk = (fill.riskTicks ?? Math.abs(fill.priceTicks - position.stopTicks)) * position.quantity;
  const amount = (ticks: number): PnlAmount => ({ ticks, currency: ticks * tickValue, r: risk > 0 ? ticks / risk : null });
  const legs = position.exits.map((exit): PnlLeg => {
    const legTicks = sign * (exit.priceTicks - fill.priceTicks);
    return { kind: exit.kind, quantity: exit.quantity, legTicks, ...amount(legTicks * exit.quantity) };
  });
  const realizedTicks = legs.reduce((sum, leg) => sum + leg.ticks, 0);
  const left = remainingQuantity(position);
  const open = left > 0 && markTicks !== null ? amount(sign * (markTicks - fill.priceTicks) * left) : null;
  return { legs, realized: amount(realizedTicks), open, total: amount(realizedTicks + (open?.ticks ?? 0)) };
}

/** The status fields tracking reads. */
export interface TrackStatus {
  readonly code: string;
  readonly connected: boolean;
  readonly bookKnown: boolean;
  readonly depthSubscribed: boolean;
  readonly missingSinceMs?: number | null;
}

const healthy: readonly string[] = ["LIVE", "SIMULATED", "REPLAY"];

/**
 * When the feed stopped being trackable, or null while it is. DEGRADED (FR-4), a dropped-trade gap, a disconnect and,
 * where depth is subscribed, an unknown book (FR-11) all are gaps.
 */
export function feedGapStart(status: TrackStatus, serverTimeMs: number): number | null {
  const missing = status.missingSinceMs ?? null;
  const unhealthy = !healthy.includes(status.code) || !status.connected || (status.depthSubscribed && !status.bookKnown);
  if (!unhealthy && missing === null) return null;
  return missing ?? serverTimeMs;
}

/** What the tracker has seen: the last print it took in, the epoch, and the open or latest gap. */
export interface TrackerState {
  readonly lastSequence: number;
  readonly epoch: number | null;
  readonly lastServerTimeMs: number | null;
  /** Feed time the open gap began, or null. */
  readonly gapSinceMs: number | null;
  /** The latest gap that has closed. */
  readonly lastGap: { readonly fromMs: number; readonly toMs: number } | null;
}

export function freshTracker(gapSinceMs: number | null): TrackerState {
  return { lastSequence: -1, epoch: null, lastServerTimeMs: null, gapSinceMs, lastGap: null };
}

/** What the browser keeps between mounts, per product, to tell a tab switch from a closed tab. */
export interface Heartbeat {
  readonly wallMs: number;
  readonly feedMs: number;
  readonly sequence: number;
  readonly epoch: number;
}

export const heartbeatStaleMs = 15_000;

function lastEventMs(position: Position): number {
  return Math.max(position.createdMs, position.fill?.timeMs ?? 0, ...position.exits.map((exit) => exit.timeMs));
}

/**
 * A tracker for a mount. A recent heartbeat carries on from its print, so a tab switch loses nothing. A stale one, or
 * a stored position with none, means nothing was tracking: the gap runs from the last thing known.
 */
export function resumeTracker(beat: Heartbeat | null, position: Position | null, nowMs: number): TrackerState {
  if (beat) {
    if (nowMs - beat.wallMs <= heartbeatStaleMs) {
      return { ...freshTracker(null), lastSequence: beat.sequence, epoch: beat.epoch, lastServerTimeMs: beat.feedMs };
    }
    return freshTracker(beat.feedMs);
  }
  if (position && isActive(position)) {
    const last = lastEventMs(position);
    if (nowMs - last > heartbeatStaleMs) return freshTracker(last);
  }
  return freshTracker(null);
}

/** What one publication gives the tracker. */
export interface TrackFeed {
  readonly prints: readonly (TrackedPrint & { readonly sequence: number })[];
  readonly epoch: number;
  readonly serverTimeMs: number;
  readonly watermarkMs: number | null;
  /** From `feedGapStart`. */
  readonly gapStartMs: number | null;
}

type SequencedPrint = TrackFeed["prints"][number];

export interface TrackStep {
  readonly tracker: TrackerState;
  readonly position: Position | null;
  /** The prints that counted. */
  readonly counted: readonly SequencedPrint[];
}

/**
 * Takes one publication in. Prints already seen, warmup prints at or before the watermark, and prints inside a gap
 * fill nothing; the prints on the first feed, or on a new epoch, count as seen and not as fills.
 */
export function advanceTracker(
  tracker: TrackerState,
  position: Position | null,
  feed: TrackFeed,
): TrackStep {
  const first = tracker.epoch === null;
  const epochChanged = !first && feed.epoch !== tracker.epoch;
  const unseen = first || epochChanged ? [] : feed.prints.filter((print) => print.sequence > tracker.lastSequence);
  const newest = feed.prints.reduce((best, print) => Math.max(best, print.sequence), first || epochChanged ? -1 : tracker.lastSequence);

  let gapSinceMs = tracker.gapSinceMs;
  let lastGap = tracker.lastGap;
  if (epochChanged) gapSinceMs ??= tracker.lastServerTimeMs ?? feed.serverTimeMs;
  if (feed.gapStartMs !== null) {
    gapSinceMs ??= feed.gapStartMs;
  } else if (gapSinceMs !== null) {
    lastGap = { fromMs: gapSinceMs, toMs: feed.serverTimeMs };
    gapSinceMs = null;
  }

  // Prints are told apart by sequence, never by time: several share a millisecond, and a later delta can bring one.
  const counted =
    gapSinceMs === null ? unseen.filter((print) => feed.watermarkMs === null || print.sourceTimeMs > feed.watermarkMs) : [];
  const next: TrackerState = { lastSequence: newest, epoch: feed.epoch, lastServerTimeMs: feed.serverTimeMs, gapSinceMs, lastGap };
  return { tracker: next, position: position && isActive(position) ? trackPrints(position, counted) : position, counted };
}

/** "not tracked since HH:MM CT" while a gap is open, "not tracked HH:MM–HH:MM CT" after one; null with no live position. */
export function trackingNote(tracker: TrackerState, position: Position | null, format: (ms: number) => string): string | null {
  if (!position || !isActive(position)) return null;
  if (tracker.gapSinceMs !== null) return `not tracked since ${format(tracker.gapSinceMs)} CT`;
  // A gap that ended before the position was placed is not the position's.
  if (tracker.lastGap && tracker.lastGap.toMs >= position.createdMs) return `not tracked ${format(tracker.lastGap.fromMs)}–${format(tracker.lastGap.toMs)} CT`;
  return null;
}

function signed(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits);
  return value > 0 ? `+${text}` : value < 0 ? `-${text}` : text;
}

/** An amount as "+4 ticks · +$5.00 · +0.40 R", with no R when the stop sits at the entry. */
export function formatAmount(amount: PnlAmount): string {
  const parts = [`${signed(amount.ticks, Number.isInteger(amount.ticks) ? 0 : 2)} ticks`, `${amount.currency < 0 ? "-" : amount.currency > 0 ? "+" : ""}$${Math.abs(amount.currency).toFixed(2)}`];
  if (amount.r !== null) parts.push(`${signed(amount.r, 2)} R`);
  return parts.join(" · ");
}
