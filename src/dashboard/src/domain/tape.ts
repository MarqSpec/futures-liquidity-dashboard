import type { Tape } from "../api/schemas.ts";
import { formatRate } from "./overview.ts";

// (REQUIREMENTS.md FR-83)

/** The canvas alpha of a signal marker raised while the tape was thin: still there, but behind the others. */
export const THIN_TAPE_ALPHA = 0.4;

/** The hover line a chart marker gains when its signal was raised on a thin tape. */
export const THIN_TAPE_LINE = "thin tape when raised";

/** Why a signal row carries the thin-tape tag. Describes activity only; it makes no claim about price. */
export const THIN_TAPE_NOTE = "Raised while the tape was thin: the trade rate was under its share of its own recent median";

/** The state in plain words, or null when an older server sent no tape. */
export function tapeStateText(tape: Tape | null): string | null {
  if (!tape) return null;
  switch (tape.state) {
    case "Thin":
      return "thin";
    case "Active":
      return "active";
    case "Unknown":
      return "no reading";
  }
}

/** The server's numbers for the state, for a hint: the rate, the median, the window and the limit. Nothing is recomputed. */
export function tapeHint(tape: Tape): string {
  if (tape.state === "Unknown" || tape.baselineRate === null || tape.thinBelowRate === null) {
    return `Tape: no reading (feed recovering or stale, exchange closed, warmup still in the last 10 s, under ${tape.baselineMinutes} minutes seen, or most of them without a print); ${formatRate(tape.rate)}`;
  }

  return `Tape ${tapeStateText(tape) ?? ""}: ${formatRate(tape.rate)} against a ${tape.baselineMinutes}-minute median of ${formatRate(tape.baselineRate)}; thin below ${formatRate(tape.thinBelowRate)}`;
}
