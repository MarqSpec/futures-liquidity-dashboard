import { useEffect, useRef, useState } from "react";

import { formatChicagoMinute } from "../domain/format.ts";
import { withPosition, type LayoutSettings } from "../domain/layout.ts";
import type { MarketState } from "../domain/merge.ts";
import type { Position } from "../domain/position.ts";
import { checkPosition, placePosition, type PositionEdit } from "../domain/positionEdit.ts";
import {
  advanceTracker,
  feedGapStart,
  isActive,
  positionPnl,
  resumeTracker,
  trackPrints,
  trackingNote,
  type Heartbeat,
  type PositionPnl,
  type TrackerState,
} from "../domain/positionTrack.ts";

// The one simulated position of the product on show (REQUIREMENTS.md FR-72, ARCHITECTURE.md D-58, D-59). Every change,
// the tracking the browser does from the live prints included, goes through the layout's `update`, which marks
// `positions` as changed so the next save sends them (D-57).

/** What a chart and its ticket need to show the position's tracking. */
export interface PositionTracking {
  /** "not tracked since HH:MM CT" across a gap, or after a closed tab; null when nothing was missed. */
  readonly note: string | null;
  /** Null until the entry fills. */
  readonly pnl: PositionPnl | null;
}

/** What a chart and its ticket need to show and edit the root's simulated position. */
export interface PositionEditor {
  readonly position: Position | null;
  /** Why the last change sprang back, until the next change is kept. */
  readonly notice: string | null;
  readonly tracking: PositionTracking;
  readonly apply: (edit: PositionEdit) => void;
  readonly clear: () => void;
  /** Places a new limit entry at `priceTicks`, replacing the root's position, once FR-72 accepts it. */
  readonly place: (priceTicks: number, lastTicks: number | null, spanTicks: number) => void;
}

export interface PositionEditorInput {
  readonly root: string;
  readonly contractId: string;
  readonly positions: LayoutSettings["positions"];
  readonly onReading?: (change: (current: LayoutSettings) => LayoutSettings) => void;
  /** The product on show: its prints, status and tick value drive the tracking. */
  readonly market: MarketState;
}

const beatKeyPrefix = "futures-liquidity-dashboard.position-beat.";
const beatEveryMs = 1_000;

function readBeat(root: string): Heartbeat | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(beatKeyPrefix + root) ?? "null");
    if (raw === null || typeof raw !== "object") return null;
    const { wallMs, feedMs, sequence, epoch } = raw as Record<string, unknown>;
    if ([wallMs, feedMs, sequence, epoch].every((value) => typeof value === "number" && Number.isFinite(value))) {
      return { wallMs, feedMs, sequence, epoch } as Heartbeat;
    }
  } catch {
    // Browser storage can be blocked or hold something else; no heartbeat reads as a stored position with none.
  }
  return null;
}

function writeBeat(root: string, beat: Heartbeat | null): void {
  try {
    if (beat) localStorage.setItem(beatKeyPrefix + root, JSON.stringify(beat));
    else localStorage.removeItem(beatKeyPrefix + root);
  } catch {
    // A heartbeat that cannot be kept only costs a gap note on the next visit.
  }
}

export function usePosition({ root, contractId, positions, onReading, market }: PositionEditorInput): PositionEditor {
  const [notice, setNotice] = useState<{ readonly root: string; readonly text: string } | null>(null);
  const [gapNote, setGapNote] = useState<{ readonly root: string; readonly text: string | null } | null>(null);
  const tracker = useRef<{ readonly root: string; state: TrackerState; lastBeatMs: number; beat: Heartbeat | null } | null>(null);
  const position = positions[root] ?? null;

  const save = (next: Position | null) => {
    setNotice(null);
    onReading?.((current) => withPosition(current, root, next));
  };

  const apply = (edit: PositionEdit) => {
    if (edit.ok) save(edit.position);
    else setNotice({ root, text: `Sprang back: ${edit.reason}` });
  };

  const { prints, status, serverTimeMs, historyWatermarkMs } = market;
  useEffect(() => {
    const nowMs = Date.now();
    if (tracker.current?.root !== root) {
      tracker.current = { root, state: resumeTracker(readBeat(root), position, nowMs), lastBeatMs: 0, beat: null };
    }
    const held = tracker.current;
    const step = advanceTracker(held.state, position, {
      prints,
      epoch: status.epoch,
      serverTimeMs,
      watermarkMs: historyWatermarkMs,
      gapStartMs: feedGapStart(status, serverTimeMs),
    });
    held.state = step.tracker;
    if (position && step.position !== position && step.counted.length > 0) {
      const counted = step.counted;
      // The updater runs once against the newest layout, so an edit made since this render is not overwritten.
      onReading?.((current) => {
        const latest = current.positions[root];
        return latest ? withPosition(current, root, trackPrints(latest, counted)) : current;
      });
    }
    const text = trackingNote(step.tracker, position, formatChicagoMinute);
    setGapNote((current) => (current?.root === root && current.text === text ? current : { root, text }));
    if (position && isActive(position)) {
      const beat: Heartbeat = { wallMs: nowMs, feedMs: serverTimeMs, sequence: step.tracker.lastSequence, epoch: status.epoch };
      held.beat = beat;
      // A beat must never lag the prints already applied to the saved position: write at once when any counted.
      if (step.counted.length > 0 || nowMs - held.lastBeatMs >= beatEveryMs) {
        held.lastBeatMs = nowMs;
        writeBeat(root, beat);
      }
    } else {
      held.lastBeatMs = 0;
      held.beat = null;
      writeBeat(root, null);
    }
  }, [root, position, prints, status, serverTimeMs, historyWatermarkMs, onReading]);

  // Leaving the view writes the newest beat, so the next mount resumes from the last print this one took in.
  useEffect(
    () => () => {
      const held = tracker.current;
      if (held?.root === root && held.beat) writeBeat(root, held.beat);
    },
    [root],
  );

  const mark = prints.at(-1)?.priceTicks ?? null;
  return {
    position,
    notice: notice?.root === root ? notice.text : null,
    tracking: {
      note: gapNote?.root === root ? gapNote.text : null,
      pnl: position ? positionPnl(position, market.instrument.tickValue, mark) : null,
    },
    apply,
    clear: () => save(null),
    // A placed position is checked like every edit: FR-72 accepts it, or it springs back with the rule it broke.
    place: (priceTicks, lastTicks, spanTicks) =>
      apply(checkPosition(placePosition({ priceTicks, lastTicks, spanTicks, contractId, nowMs: Date.now() }))),
  };
}
