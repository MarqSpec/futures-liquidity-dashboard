import { formatTickRange, type TickSpec } from "../domain/format.ts";
import type { GroupMark } from "../domain/signalClusters.ts";
import type { PositionFrame } from "./PositionLines.tsx";

// reference: REQUIREMENTS.md FR-82; ARCHITECTURE.md D-69

export interface GroupBandProps {
  /** The group hovered or selected in the Signals panel; nothing is drawn without one. */
  readonly mark: GroupMark | null;
  readonly frame: PositionFrame;
  readonly spec: TickSpec;
}

function yOf(frame: PositionFrame, ticks: number): number {
  const span = frame.highTicks - frame.lowTicks;
  if (span <= 0) return (frame.top + frame.bottom) / 2;
  return frame.top + ((frame.highTicks - ticks) / span) * (frame.bottom - frame.top);
}

/**
 * A signal group's price range shaded across the plot, half a tick beyond each end so a one-tick group is a row, not a
 * line. A range wholly outside the view is named at the edge it lies beyond. Marks a place, never a direction (FR-82).
 */
export function GroupBand({ mark, frame, spec }: GroupBandProps) {
  if (!mark || frame.bottom <= frame.top) return null;
  const range = formatTickRange(mark.lowTicks, mark.highTicks, spec);
  if (mark.lowTicks > frame.highTicks || mark.highTicks < frame.lowTicks) {
    const above = mark.lowTicks > frame.highTicks;
    return (
      <div className="group-band-layer" aria-hidden="true">
        <span className="group-band-label" style={above ? { top: frame.top, left: frame.left + 4 } : { bottom: 0, left: frame.left + 4 }}>
          Group {range} {above ? "above" : "below"} the view
        </span>
      </div>
    );
  }
  const top = Math.max(frame.top, yOf(frame, mark.highTicks + 0.5));
  const bottom = Math.min(frame.bottom, yOf(frame, mark.lowTicks - 0.5));
  return (
    <div className="group-band-layer" aria-hidden="true">
      <div className="group-band" style={{ top, height: bottom - top, left: frame.left, width: frame.right - frame.left }} />
      <span className="group-band-label" style={{ top, left: frame.left + 4 }}>
        Group {range}
      </span>
    </div>
  );
}
