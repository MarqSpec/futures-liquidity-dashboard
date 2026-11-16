import { signalKinds, type Signal, type SignalKind } from "../api/schemas.ts";
import { formatChicagoTime, formatLocalTime, formatPercent, formatTickRange, type TickSpec } from "../domain/format.ts";
import { countByKind, kindName, visibleSignals } from "../domain/signals.ts";
import { SidePanel, type SideFold } from "./SidePanel.tsx";

/** Props of the signals panel. */
export interface SignalsPanelProps {
  readonly signals: readonly Signal[];
  readonly spec: TickSpec;
  readonly isKindOn: (kind: string) => boolean;
  readonly onToggleKind: (kind: SignalKind, on: boolean) => void;
  readonly fold?: SideFold;
}

const LIST_LIMIT = 200;

/**
 * The order-flow signals, newest first, with one toggle per kind that hides or shows that kind here, on the chart
 * and on the ladder. A signal is a fact about what the feed showed, never a recommendation.
 */
export function SignalsPanel({ signals, spec, isKindOn, onToggleKind, fold }: SignalsPanelProps) {
  const counts = countByKind(signals);
  const shown = visibleSignals(signals, isKindOn, LIST_LIMIT);
  return (
    <SidePanel label="Order-flow signals" title="Signals" fold={fold}>
      <fieldset className="kind-toggles">
        <legend>Signal kinds</legend>
        {signalKinds.map((kind) => (
          <label key={kind} className="toggle">
            <input type="checkbox" checked={isKindOn(kind)} onChange={(e) => onToggleKind(kind, e.target.checked)} />
            {kindName(kind)} <span className="muted">{counts.get(kind) ?? 0}</span>
          </label>
        ))}
      </fieldset>
      {shown.length === 0 ? (
        <p className="muted">No signals to show.</p>
      ) : (
        <ol className="ld-list ld-scroll" aria-live="off">
          {shown.map((signal) => {
            const tone = signal.bias.toLowerCase();
            return (
              <li key={signal.id} className={`ld-signal ld-signal--${tone}`}>
                <span className="ld-dot" aria-hidden="true" />
                <span className="kind">{kindName(signal.kind)}</span>
                <span className="when" title={formatChicagoTime(signal.timeMs)}>
                  {formatLocalTime(signal.timeMs)}
                </span>
                <span className="detail">
                  {signal.label} @ {formatTickRange(signal.priceTicks, signal.priceHighTicks, spec)} · {signal.detail} · {tone} · strength{" "}
                  {formatPercent(signal.strength)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </SidePanel>
  );
}
