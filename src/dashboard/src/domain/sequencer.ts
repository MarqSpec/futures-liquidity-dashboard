import type { Delta, Snapshot } from "../api/schemas.ts";
import { applyDelta, fromSnapshot, type MarketState } from "./merge.ts";

/**
 * Where one instrument's stream stands (REQUIREMENTS.md NFR-5). Deltas that arrive before the subscribe snapshot are
 * buffered; once it lands, those at or below its seq are dropped and the rest applied in order.
 */
export type StreamPhase =
  | { readonly kind: "awaiting-snapshot"; readonly root: string; readonly buffered: readonly Delta[] }
  | { readonly kind: "live"; readonly state: MarketState };

/** A phase and whether the caller must re-subscribe because a delta is missing. */
export interface StreamStep {
  readonly phase: StreamPhase;
  readonly resync: boolean;
}

/** Deltas held while waiting for a snapshot; at ~4 per second this is ~50 s, far longer than a subscribe takes. */
export const MAX_BUFFERED = 200;

/** The phase right after (re)subscribing to `root`. */
export function awaitSnapshot(root: string, buffered: readonly Delta[] = []): StreamPhase {
  return { kind: "awaiting-snapshot", root, buffered };
}

/** The root a phase is for. */
export function phaseRoot(phase: StreamPhase): string {
  switch (phase.kind) {
    case "awaiting-snapshot":
      return phase.root;
    case "live":
      return phase.state.root;
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

/**
 * Applies the deltas of `pending` in seq order on top of `state`: those at or below its seq are dropped, each
 * seq === last + 1 is applied, and the first gap stops and asks for a resync.
 */
function drain(state: MarketState, pending: readonly Delta[], nowMs: number): StreamStep {
  let current = state;
  const ordered = [...pending].sort((a, b) => a.seq - b.seq);
  for (const delta of ordered) {
    if (delta.seq <= current.seq) {
      continue;
    }
    if (delta.seq !== current.seq + 1) {
      // Nothing buffered is kept: the next snapshot covers it, and a stale delta must not trip every snapshot.
      return { phase: awaitSnapshot(current.root), resync: true };
    }
    current = applyDelta(current, delta, nowMs);
  }
  return { phase: { kind: "live", state: current }, resync: false };
}

/** Handles one delta: buffer it, drop it as old, apply it, or detect a gap and ask for a resync. */
export function receiveDelta(phase: StreamPhase, delta: Delta, nowMs: number): StreamStep {
  if (delta.root !== phaseRoot(phase)) {
    // A delta for an instrument this view has just left.
    return { phase, resync: false };
  }
  switch (phase.kind) {
    case "awaiting-snapshot": {
      const buffered = [...phase.buffered, delta];
      return {
        phase: awaitSnapshot(phase.root, buffered.slice(Math.max(0, buffered.length - MAX_BUFFERED))),
        resync: false,
      };
    }
    case "live": {
      const { state } = phase;
      if (delta.seq <= state.seq) {
        return { phase, resync: false };
      }
      if (delta.seq !== state.seq + 1) {
        return { phase: awaitSnapshot(state.root, [delta]), resync: true };
      }
      return { phase: { kind: "live", state: applyDelta(state, delta, nowMs) }, resync: false };
    }
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

/** Handles a subscribe result: replace the state with it and apply whatever was buffered after it. */
export function receiveSnapshot(
  phase: StreamPhase,
  snapshot: Snapshot,
  historyMinutes: number,
  nowMs: number,
): StreamStep {
  const buffered = phase.kind === "awaiting-snapshot" && phase.root === snapshot.root ? phase.buffered : [];
  return drain(fromSnapshot(snapshot, historyMinutes, nowMs), buffered, nowMs);
}
