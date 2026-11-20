import type { EndedWall } from "../api/schemas.ts";
import { formatAge, formatQty } from "./format.ts";

// reference: REQUIREMENTS.md FR-78 (an ended wall's outcome describes how its size left, never intent)

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  Filled: "mostly filled",
  Pulled: "mostly pulled",
  BelowThreshold: "below threshold",
};

/** How an ended wall's size left, in words; a value a newer server adds is shown as sent. */
export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

/** The ended wall's side, outcome, how long it stood, its peak and FR-38's split of what left. */
export function endedWallTitle(wall: EndedWall): string {
  return `ended ${wall.side.toLowerCase()} wall, ${outcomeLabel(wall.outcome)} after ${formatAge(wall.stoodMs)}: peak ${formatQty(wall.peakQuantity)}, ${formatQty(wall.filled)} filled, ${formatQty(wall.pulled)} pulled`;
}
