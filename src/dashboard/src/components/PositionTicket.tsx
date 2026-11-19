import { useState, type KeyboardEvent, type ReactNode } from "react";

import { formatChicagoMinute, formatTicks, priceToTicks, type TickSpec } from "../domain/format.ts";
import { maxPositionTargets, type Position } from "../domain/position.ts";
import { formatAmount, remainingQuantity } from "../domain/positionTrack.ts";
import type { PositionTracking } from "../hooks/usePosition.ts";
import {
  addTarget,
  moveLine,
  removeTarget,
  withEntryType,
  withQuantity,
  withSide,
  withTargetQuantity,
  type PositionEdit,
  type PositionLine,
} from "../domain/positionEdit.ts";

// The simulated position's ticket (REQUIREMENTS.md FR-72, NFR-8; ARCHITECTURE.md D-58): every field the chart's lines show,
// editable from the keyboard. A typed value is applied on Enter or when focus leaves the field; Escape restores it.

export interface PositionTicketProps {
  readonly root: string;
  readonly position: Position | null;
  readonly spec: TickSpec;
  readonly lastTicks: number | null;
  /** Where the paper tracking stands: P&L and any time it missed (FR-72, D-59). */
  readonly tracking?: PositionTracking;
  /** Why the last change sprang back. */
  readonly notice: string | null;
  readonly onApply: (edit: PositionEdit) => void;
  readonly onClear: () => void;
  /** Places a limit entry at the last price, for the keyboard. */
  readonly onPlace: () => void;
  /** The Feedback button (FR-74). Absent, or `offered` false: no button renders. */
  readonly feedback?: { readonly offered: boolean; readonly busy: boolean; readonly onRequest: () => void };
}

type FieldId = "quantity" | "entry" | "stop" | `target-${number}` | `target-${number}-qty`;

/** What the position is doing, in words: waiting, filled where, or closed. */
function stateText(position: Position, spec: TickSpec): string {
  const price = (ticks: number) => formatTicks(ticks, spec);
  switch (position.state) {
    case "planned":
      return "Planned: waits for the next live print";
    case "working":
      return position.entryType === "market" || position.entryTicks === null || position.entryTicks === undefined
        ? "Working: fills at the next print"
        : `Working: fills on a print ${position.side === "long" ? "below" : "above"} ${price(position.entryTicks)}`;
    case "filled":
      return `Filled ×${position.quantity} at ${price(position.fill?.priceTicks ?? 0)} ${formatChicagoMinute(position.fill?.timeMs ?? 0)} CT, ${remainingQuantity(position)} open`;
    case "closed":
      return `Closed: filled at ${price(position.fill?.priceTicks ?? 0)}`;
  }
}

function parseWhole(text: string): number {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** The simulated position's compact ticket, or, with none, the way to place one. */
export function PositionTicket({ root, position, spec, lastTicks, tracking, notice, onApply, onClear, onPlace, feedback }: PositionTicketProps) {
  const [drafts, setDrafts] = useState<Partial<Record<FieldId, string>>>({});
  const forget = (field: FieldId) =>
    setDrafts((current) => {
      const { [field]: _dropped, ...rest } = current;
      return rest;
    });

  const priceEdit = (current: Position, line: PositionLine) => (text: string): PositionEdit => {
    const price = Number(text.trim().replace(/,/g, ""));
    if (text.trim() === "" || !Number.isFinite(price)) return { ok: false, reason: "enter a price" };
    return moveLine(current, line, priceToTicks(price, spec));
  };

  const field = (id: FieldId, label: ReactNode, shown: string, edit: (text: string) => PositionEdit, options: { numeric?: boolean; disabled?: boolean } = {}) => {
    const commit = () => {
      const draft = drafts[id];
      if (draft === undefined) return;
      forget(id);
      if (draft !== shown) onApply(edit(draft));
    };
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        forget(id);
      }
    };
    return (
      <label className="position-field">
        <span>{label}</span>
        <input
          type="text"
          inputMode={options.numeric ? "numeric" : "decimal"}
          size={options.numeric ? 3 : 9}
          value={drafts[id] ?? shown}
          disabled={options.disabled}
          onChange={(event) => setDrafts((current) => ({ ...current, [id]: event.target.value }))}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </label>
    );
  };

  const entryFixed = position?.state === "filled" || position?.state === "closed";

  return (
    <section className="position-ticket" aria-label={`Simulated position ${root}`}>
      <span className="position-badge">SIMULATED</span>
      {position === null ? (
        <p className="position-empty">
          Alt-click the chart to place a simulated entry, or
          <button type="button" disabled={lastTicks === null} onClick={onPlace}>
            Place at last price
          </button>
        </p>
      ) : (
        <>
          <label className="position-field">
            <span>Side</span>
            <select disabled={entryFixed} value={position.side} onChange={(event) => onApply(withSide(position, event.target.value === "short" ? "short" : "long"))}>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </label>
          <label className="position-field">
            <span>Type</span>
            <select
              disabled={entryFixed}
              value={position.entryType}
              onChange={(event) => onApply(withEntryType(position, event.target.value === "market" ? "market" : "limit", lastTicks))}
            >
              <option value="limit">Limit</option>
              <option value="market">Market</option>
            </select>
          </label>
          {field("quantity", "Quantity", String(position.quantity), (text) => withQuantity(position, parseWhole(text)), { numeric: true, disabled: entryFixed })}
          {position.entryTicks === null || position.entryTicks === undefined
            ? field("entry", "Entry", "Market", () => ({ ok: false, reason: "a market entry has no price" }), { disabled: true })
            : field("entry", "Entry", formatTicks(position.entryTicks, spec), priceEdit(position, { kind: "entry" }), { disabled: entryFixed })}
          {field("stop", "Stop", formatTicks(position.stopTicks, spec), priceEdit(position, { kind: "stop" }))}
          {position.targets.map((target, index) => (
            // A target's slot is its index: removing one renumbers the rest, as the lines do.
            // oxlint-disable-next-line react/no-array-index-key
            <span className="position-target" key={index}>
              {field(`target-${index}`, `Target ${index + 1}`, formatTicks(target.priceTicks, spec), priceEdit(position, { kind: "target", index }))}
              {field(
                `target-${index}-qty`,
                <>
                  <span className="visually-hidden">Target {index + 1} </span>qty
                </>,
                String(target.quantity), (text) => withTargetQuantity(position, index, parseWhole(text)), {
                numeric: true,
              })}
              <button type="button" className="position-remove" aria-label={`Remove target ${index + 1}`} onClick={() => onApply(removeTarget(position, index))}>
                ×
              </button>
            </span>
          ))}
          <button type="button" disabled={position.targets.length >= maxPositionTargets || position.state === "closed"} onClick={() => onApply(addTarget(position))}>
            Add target
          </button>
          <button type="button" onClick={onClear}>
            Clear
          </button>
          <span className="position-track" data-position-state={position.state}>
            <span className="position-state">{stateText(position, spec)}</span>
            {position.exits.map((exit, index) => (
              // An exit's slot is its place in the order they filled.
              // oxlint-disable-next-line react/no-array-index-key
              <span className="position-exit" key={index}>
                {`${exit.kind === "stop" ? "Stop" : "Target"} ×${exit.quantity} at ${formatTicks(exit.priceTicks, spec)}`}
                {tracking?.pnl?.legs[index] && ` · ${formatAmount(tracking.pnl.legs[index])}`}
              </span>
            ))}
            {tracking?.pnl && (
              <span className="position-pnl" aria-label="Simulated P&L">
                {tracking.pnl.open && <span>{`open ${formatAmount(tracking.pnl.open)}`}</span>}
                {tracking.pnl.legs.length > 0 && <span>{`realized ${formatAmount(tracking.pnl.realized)}`}</span>}
                <strong>{`total ${formatAmount(tracking.pnl.total)}`}</strong>
              </span>
            )}
            {tracking?.note && <span className="position-gap">{tracking.note}</span>}
          </span>
          {feedback?.offered && (
            <button type="button" disabled={feedback.busy} aria-busy={feedback.busy} onClick={feedback.onRequest}>
              {feedback.busy ? "Asking…" : "Feedback"}
            </button>
          )}
        </>
      )}
      <output className="position-notice">{notice ?? ""}</output>
    </section>
  );
}

