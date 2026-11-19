import { useState, type PointerEvent } from "react";

import type { FeedbackGhost } from "../domain/feedback.ts";
import { formatTicks, type TickSpec } from "../domain/format.ts";
import type { Position } from "../domain/position.ts";
import { lineKey, moveLine, positionLines, type PositionEdit, type PositionLine } from "../domain/positionEdit.ts";

// The simulated position's lines over a chart's plot (REQUIREMENTS.md FR-72, ARCHITECTURE.md D-58). Each is a thin strip that
// takes its own presses; the layer around them takes none, so the chart beneath still pans, zooms and reads out.

/** Where the plot is in the chart's box, in CSS pixels, and the prices at its bottom and top edges. */
export interface PositionFrame {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /** The price axis's width, right of the plot, where each line's price tag sits. */
  readonly axisWidth: number;
  readonly lowTicks: number;
  readonly highTicks: number;
}

export interface PositionLinesProps {
  readonly position: Position | null;
  readonly spec: TickSpec;
  readonly frame: PositionFrame | null;
  /** Why the last change sprang back, shown on the plot. */
  readonly notice: string | null;
  readonly onApply: (edit: PositionEdit) => void;
  /** Feedback suggestions drawn as dashed ghost lines; one click applies one (FR-74). */
  readonly ghosts?: readonly FeedbackGhost[];
  readonly onApplyGhost?: (ghost: FeedbackGhost) => void;
}

interface Drag {
  readonly key: string;
  readonly line: PositionLine;
  readonly pointer: number;
  readonly startY: number;
  readonly startTicks: number;
  readonly ticks: number;
}

/** The height of one off-range marker, in CSS pixels; matches `.position-offscreen`'s line height. */
const EDGE_ROW_PX = 16;

function yOf(frame: PositionFrame, ticks: number): number {
  const span = frame.highTicks - frame.lowTicks;
  if (span <= 0) return (frame.top + frame.bottom) / 2;
  return frame.top + ((frame.highTicks - ticks) / span) * (frame.bottom - frame.top);
}

/** The position's entry, stop and targets as draggable lines with price tags; nothing without a position or a plot. */
export function PositionLines({ position, spec, frame, notice, onApply, ghosts = [], onApplyGhost }: PositionLinesProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  if (!position || !frame || frame.bottom <= frame.top) return null;
  const ticksPerPx = (frame.highTicks - frame.lowTicks) / (frame.bottom - frame.top);

  const down = (event: PointerEvent<HTMLDivElement>, line: PositionLine, priceTicks: number) => {
    // The chart beneath must not see this press, or it would pan as the line moves.
    event.stopPropagation();
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ key: lineKey(line), line, pointer: event.pointerId, startY: event.clientY, startTicks: priceTicks, ticks: priceTicks });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!drag || drag.pointer !== event.pointerId) return;
    const raw = drag.startTicks - (event.clientY - drag.startY) * ticksPerPx;
    const ticks = Math.min(frame.highTicks, Math.max(frame.lowTicks, Math.round(raw)));
    if (ticks !== drag.ticks) setDrag({ ...drag, ticks });
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!drag || drag.pointer !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
    // A refused drop springs back: the line returns to the stored price and the reason is shown.
    if (drag.ticks !== drag.startTicks) onApply(moveLine(position, drag.line, drag.ticks));
  };

  const lines = positionLines(position);
  // A line off the visible range is marked at the edge it lies beyond, so a pan or a refit never hides it silently.
  const above = lines.filter((view) => view.priceTicks > frame.highTicks);
  const below = lines.filter((view) => view.priceTicks < frame.lowTicks);

  return (
    <div className="position-layer" aria-hidden="true">
      {above.map(({ line, priceTicks, label }, index) => (
        <span
          key={`above-${lineKey(line)}`}
          className={`position-offscreen position-line-${line.kind}`}
          style={{ top: frame.top + index * EDGE_ROW_PX, left: frame.left + 4 }}
        >
          {`▲ ${label} ${formatTicks(priceTicks, spec)}`}
        </span>
      ))}
      {below.map(({ line, priceTicks, label }, index) => (
        <span
          key={`below-${lineKey(line)}`}
          className={`position-offscreen position-line-${line.kind}`}
          style={{ top: frame.bottom - (index + 1) * EDGE_ROW_PX, left: frame.left + 4 }}
        >
          {`▼ ${label} ${formatTicks(priceTicks, spec)}`}
        </span>
      ))}
      {lines.map(({ line, priceTicks, label, done }) => {
        const key = lineKey(line);
        const shown = drag?.key === key ? drag.ticks : priceTicks;
        if (priceTicks < frame.lowTicks || priceTicks > frame.highTicks) return null;
        const top = Math.round(yOf(frame, shown) * 10) / 10;
        return (
          <div
            key={key}
            data-position-line={key}
            className={`position-line position-line-${line.kind}${done ? " position-line-done" : ""}${line.kind === "fill" ? " position-line-fixed" : ""}${drag?.key === key ? " position-line-dragging" : ""}`}
            style={{ top, left: frame.left, width: frame.right - frame.left + frame.axisWidth }}
            onPointerDown={(event) => down(event, line, priceTicks)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <span className="position-line-label">{label}</span>
            <span className="position-tag" style={{ width: frame.axisWidth }}>
              {formatTicks(shown, spec)}
            </span>
          </div>
        );
      })}
      {ghosts.map((ghost) => {
        if (ghost.priceTicks < frame.lowTicks || ghost.priceTicks > frame.highTicks) return null;
        return (
          // The same move is a button in the feedback panel, so this strip is the pointer's way, not the only way.
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
          <div
            key={ghost.key}
            data-position-ghost={ghost.key}
            className={`position-ghost position-line-${ghost.line.kind}`}
            style={{ top: Math.round(yOf(frame, ghost.priceTicks) * 10) / 10, left: frame.left, width: frame.right - frame.left + frame.axisWidth }}
            title="Click to apply this suggestion to the simulated position"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={() => onApplyGhost?.(ghost)}
          >
            <span className="position-line-label">{`${ghost.label} · click to apply`}</span>
            <span className="position-tag" style={{ width: frame.axisWidth }}>
              {formatTicks(ghost.priceTicks, spec)}
            </span>
          </div>
        );
      })}
      {notice && (
        <p className="position-layer-notice" style={{ left: frame.left + 8, top: frame.top + 8 }}>
          {notice}
        </p>
      )}
    </div>
  );
}
