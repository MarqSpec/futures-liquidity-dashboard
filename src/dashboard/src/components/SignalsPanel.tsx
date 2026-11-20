import { useMemo } from "react";

import { signalKinds, type Signal, type SignalKind } from "../api/schemas.ts";
import { formatChicagoTime, formatLocalTime, formatPercent, formatQty, formatTickRange, formatTicks, type TickSpec } from "../domain/format.ts";
import {
  countHiddenByFloors,
  ICEBERG_INFERRED_NOTE,
  signalRows,
  withoutIcebergNote,
  type IcebergFloors,
  type SignalCluster,
} from "../domain/signalClusters.ts";
import { countByKind, kindName } from "../domain/signals.ts";
import { SidePanel, type SideFold } from "./SidePanel.tsx";

/** Props of the signals panel. */
export interface SignalsPanelProps {
  readonly signals: readonly Signal[];
  readonly spec: TickSpec;
  /** Asked for each of `signalKinds`, the kinds a layout can toggle; a kind the server added later is always listed. */
  readonly isKindOn: (kind: string) => boolean;
  readonly onToggleKind: (kind: SignalKind, on: boolean) => void;
  /** The iceberg floors saved on the layout (REQUIREMENTS.md FR-80, FR-9). */
  readonly floors: IcebergFloors;
  /** Saves new floors. Without it the floors are shown and cannot be edited. */
  readonly onFloors?: (floors: IcebergFloors) => void;
  readonly fold?: SideFold;
}

const LIST_LIMIT = 200;
const knownKinds: ReadonlySet<string> = new Set(signalKinds);

function SignalRowView({ signal, spec }: { readonly signal: Signal; readonly spec: TickSpec }) {
  const tone = signal.bias.toLowerCase();
  return (
    <li className={`ld-signal ld-signal--${tone}`}>
      <span className="ld-dot" aria-hidden="true" />
      <span className="kind">{kindName(signal.kind)}</span>
      <span className="when" title={formatChicagoTime(signal.timeMs)}>
        {formatLocalTime(signal.timeMs)}
      </span>
      <span className="detail">
        {signal.label} @ {formatTickRange(signal.priceTicks, signal.priceHighTicks, spec)} · {withoutIcebergNote(signal)} · {tone} · strength{" "}
        {formatPercent(signal.strength)}
      </span>
    </li>
  );
}

function ClusterRowView({ cluster, spec }: { readonly cluster: SignalCluster; readonly spec: TickSpec }) {
  const { strongest, members } = cluster;
  const tone = strongest.bias.toLowerCase();
  const hidden = cluster.hiddenAtLeast == null ? "" : ` · hidden ≥ ${formatQty(cluster.hiddenAtLeast)} summed`;
  return (
    <li className={`ld-signal ld-signal--${tone} ld-signal--cluster`}>
      <span className="ld-dot" aria-hidden="true" />
      <span className="kind">{kindName(strongest.kind)}</span>
      <span className="when" title={`${formatChicagoTime(cluster.firstMs)} – ${formatChicagoTime(cluster.lastMs)}`}>
        {formatLocalTime(cluster.firstMs)} – {formatLocalTime(cluster.lastMs)}
      </span>
      <span className="detail">
        {strongest.label} ×{members.length} @ {formatTickRange(cluster.lowTicks, cluster.highTicks, spec)}
        {hidden} · strongest {formatPercent(strongest.strength)} @ {formatTicks(strongest.priceTicks, spec)} · {tone}
      </span>
      <details className="ld-cluster-members">
        <summary>Show {members.length} icebergs</summary>
        <ol className="ld-list" aria-label="Icebergs in this cluster">
          {members.map((member) => (
            <SignalRowView key={member.id} signal={member} spec={spec} />
          ))}
        </ol>
      </details>
    </li>
  );
}

/**
 * The order-flow signals, newest first, with one toggle per kind that hides or shows that kind here, on the chart
 * and on the ladder. Icebergs below the layout's floors are left out of this list only, and icebergs on one side
 * within 4 ticks and 60 s of each other are one row (ARCHITECTURE.md D-66). A signal is a fact about what the feed
 * showed, never a recommendation.
 */
export function SignalsPanel({ signals, spec, isKindOn, onToggleKind, floors, onFloors, fold }: SignalsPanelProps) {
  const counts = countByKind(signals);
  const hidden = countHiddenByFloors(signals, floors);
  const kindsOn = signalKinds.filter((kind) => isKindOn(kind)).join(",");
  const { minStrengthPercent, minHiddenSize } = floors;
  // Keyed on values, not the caller's fresh closures, so a pan or zoom render does not re-cluster the history.
  const rows = useMemo(() => {
    const on = new Set(kindsOn.split(","));
    return signalRows(signals, (kind) => on.has(kind) || !knownKinds.has(kind), { minStrengthPercent, minHiddenSize }, LIST_LIMIT);
  }, [signals, kindsOn, minStrengthPercent, minHiddenSize]);
  const setFloor = (field: keyof IcebergFloors, value: string) => onFloors?.({ ...floors, [field]: Number(value) });
  return (
    <SidePanel label="Order-flow signals" title="Signals" fold={fold}>
      <fieldset className="kind-toggles">
        <legend>Signal kinds</legend>
        {signalKinds.map((kind) => {
          const below = hidden.get(kind) ?? 0;
          return (
            <label key={kind} className="toggle">
              <input type="checkbox" checked={isKindOn(kind)} onChange={(e) => onToggleKind(kind, e.target.checked)} />
              {kindName(kind)} <span className="muted">{counts.get(kind) ?? 0}</span>
              {below > 0 && <span className="muted">{` (${below} below floors)`}</span>}
            </label>
          );
        })}
      </fieldset>
      <fieldset className="iceberg-floors">
        <legend>Iceberg floors</legend>
        <label>
          Strength ≥ %
          <input
            type="number"
            min={0}
            max={100}
            aria-label="Minimum iceberg strength (%)"
            value={floors.minStrengthPercent}
            disabled={!onFloors}
            onChange={(e) => setFloor("minStrengthPercent", e.target.value)}
          />
        </label>
        <label>
          Hidden ≥
          <input
            type="number"
            min={0}
            max={100000}
            aria-label="Minimum iceberg hidden size"
            value={floors.minHiddenSize}
            disabled={!onFloors}
            onChange={(e) => setFloor("minHiddenSize", e.target.value)}
          />
        </label>
      </fieldset>
      {isKindOn("Iceberg") && <p className="muted signals-note">Icebergs: {ICEBERG_INFERRED_NOTE.toLowerCase()}</p>}
      {rows.length === 0 ? (
        <p className="muted">No signals to show.</p>
      ) : (
        <ol className="ld-list ld-scroll" aria-live="off" aria-label="Signals, newest first">
          {rows.map((row) =>
            row.type === "single" ? (
              <SignalRowView key={row.signal.id} signal={row.signal} spec={spec} />
            ) : (
              <ClusterRowView key={`cluster-${row.cluster.members.at(-1)?.id ?? 0}`} cluster={row.cluster} spec={spec} />
            ),
          )}
        </ol>
      )}
    </SidePanel>
  );
}
