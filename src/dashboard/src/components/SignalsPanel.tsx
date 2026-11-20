import { memo, useState, type ReactNode } from "react";
import { signalKinds, type Signal, type SignalKind } from "../api/schemas.ts";
import { formatChicagoTime, formatLocalTime, formatPercent, formatQty, formatTickRange, formatTicks, type TickSpec } from "../domain/format.ts";
import {
  countHiddenByFloors,
  groupMark,
  ICEBERG_INFERRED_NOTE,
  MEMBER_LIST_LIMIT,
  withoutIcebergNote,
  type GroupMark,
  type IcebergFloors,
  type MemberRow,
  type SignalCluster,
  type SignalGroup,
  type SignalRow,
} from "../domain/signalClusters.ts";
import { countByKind, kindName } from "../domain/signals.ts";
import { useSignalRows } from "../hooks/useSignalRows.ts";
import { THIN_TAPE_NOTE } from "../domain/tape.ts";
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
  /** Told a group's mark while the pointer or focus is on its row, and null when it leaves (FR-82). */
  readonly onHoverGroup?: (mark: GroupMark | null) => void;
  /** The key of the group selected for the chart, if any. */
  readonly selectedGroup?: string | null;
  /** Selects a group for the chart, or clears the selection with null. Without it no row offers to mark the chart. */
  readonly onSelectGroup?: (mark: GroupMark | null) => void;
  /** The rows to list, when the caller already holds them (`useSignalRows`); otherwise the panel computes its own. */
  readonly rows?: readonly SignalRow[];
}

interface MembersProps {
  readonly summary: string;
  readonly label: string;
  readonly total: number;
  /** What the overflow line counts: "+N more" for signals, "+N more rows" for a group's rows (a row may hold several signals). */
  readonly moreNoun?: string;
  /** Renders the first `count` members; called only while the row is open. */
  readonly children: (count: number) => ReactNode;
}

/** A closed row mounts no members: they render while it is open, at most MEMBER_LIST_LIMIT of them. */
function Members({ summary, label, total, moreNoun = "", children }: MembersProps) {
  const [open, setOpen] = useState(false);
  return (
    <details className="ld-cluster-members" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && (
        <ol className="ld-list" aria-label={label}>
          {children(Math.min(total, MEMBER_LIST_LIMIT))}
          {total > MEMBER_LIST_LIMIT && <li className="muted ld-more">+{total - MEMBER_LIST_LIMIT} more{moreNoun}</li>}
        </ol>
      )}
    </details>
  );
}

const SignalRowView = memo(function SignalRowView({ signal, spec }: { readonly signal: Signal; readonly spec: TickSpec }) {
  const tone = signal.bias.toLowerCase();
  return (
    <li className={`ld-signal ld-signal--${tone}${signal.thinTape === true ? " ld-signal--thin" : ""}`}>
      <span className="ld-dot" aria-hidden="true" />
      <span className="kind">{kindName(signal.kind)}</span>
      <span className="when" title={formatChicagoTime(signal.timeMs)}>
        {formatLocalTime(signal.timeMs)}
      </span>
      <span className="detail">
        {signal.label} @ {formatTickRange(signal.priceTicks, signal.priceHighTicks, spec)} · {withoutIcebergNote(signal)} · {tone} · strength{" "}
        {formatPercent(signal.strength)}
      </span>
      {signal.thinTape === true && (
        <span className="tape-tag tape-thin" title={THIN_TAPE_NOTE}>
          thin tape
        </span>
      )}
    </li>
  );
});

const ClusterRowView = memo(function ClusterRowView({ cluster, spec }: { readonly cluster: SignalCluster; readonly spec: TickSpec }) {
  const { strongest, members } = cluster;
  const tone = strongest.bias.toLowerCase();
  const hidden = cluster.hiddenAtLeast == null ? "" : ` · hidden ≥ ${formatQty(cluster.hiddenAtLeast)} summed`;
  const thin = members.filter((member) => member.thinTape === true).length;
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
        {thin > 0 && ` · ${thin} on a thin tape`}
      </span>
      <Members summary={`Show ${members.length} icebergs`} label="Icebergs in this cluster" total={members.length}>
        {(count) => members.slice(0, count).map((member) => <SignalRowView key={member.id} signal={member} spec={spec} />)}
      </Members>
    </li>
  );
});

const MemberRowView = memo(function MemberRowView({ row, spec }: { readonly row: MemberRow; readonly spec: TickSpec }) {
  return row.type === "single" ? <SignalRowView signal={row.signal} spec={spec} /> : <ClusterRowView cluster={row.cluster} spec={spec} />;
});

/** How many of a row's signals were raised on a thin tape (REQUIREMENTS.md FR-83), counting inside an iceberg cluster. */
function thinCount(row: MemberRow): number {
  return row.type === "single" ? (row.signal.thinTape === true ? 1 : 0) : row.cluster.members.filter((member) => member.thinTape === true).length;
}

function memberKey(row: MemberRow): string {
  return row.type === "single" ? `${row.signal.id}` : `cluster-${row.cluster.members.at(-1)?.id ?? 0}`;
}

interface GroupRowViewProps {
  readonly group: SignalGroup;
  readonly spec: TickSpec;
  readonly selected: boolean;
  readonly onHover?: (mark: GroupMark | null) => void;
  readonly onSelect?: (mark: GroupMark | null) => void;
}

/** Signals of several kinds at one place and time: what they are and where, with no direction of its own (FR-82). */
const GroupRowView = memo(function GroupRowView({ group, spec, selected, onHover, onSelect }: GroupRowViewProps) {
  const mark = groupMark(group);
  const kinds = group.kinds
    .map(({ kind, count, strongest }) =>
      count === 1 ? `${kindName(kind)} ${formatPercent(strongest)}` : `${kindName(kind)} ×${count}, strongest ${formatPercent(strongest)}`,
    )
    .join(" · ");
  const thin = group.members.reduce((sum, member) => sum + thinCount(member), 0);
  const enter = () => onHover?.(mark);
  const leave = () => onHover?.(null);
  // Hover only previews the mark; the Mark on chart button does the same for keyboard and touch, and focus inside the row previews it too.
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <li
      className={`ld-signal ld-signal--group${selected ? " ld-signal--selected" : ""}`}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
    >
      <span className="ld-dot" aria-hidden="true" />
      <span className="kind">Group</span>
      <span className="when" title={`${formatChicagoTime(group.firstMs)} – ${formatChicagoTime(group.lastMs)}`}>
        {formatLocalTime(group.firstMs)} – {formatLocalTime(group.lastMs)}
      </span>
      <span className="detail">
        {kinds} @ {formatTickRange(group.lowTicks, group.highTicks, spec)} · {group.count} signals
        {thin > 0 && ` · ${thin} on a thin tape`}
      </span>
      {onSelect && (
        <button type="button" className="small text ld-group-mark" aria-pressed={selected} onClick={() => onSelect(selected ? null : mark)}>
          Mark on chart
        </button>
      )}
      <Members summary={`Show ${group.count} signals`} label="Signals in this group" total={group.members.length} moreNoun=" rows">
        {(count) => group.members.slice(0, count).map((member) => <MemberRowView key={memberKey(member)} row={member} spec={spec} />)}
      </Members>
    </li>
  );
});

/**
 * The order-flow signals, newest first, with one toggle per kind that hides or shows that kind here, on the chart
 * and on the ladder. Icebergs below the layout's floors are left out of this list only, and icebergs on one side
 * within 4 ticks and 60 s of each other are one row (ARCHITECTURE.md D-66). Signals of two or more kinds within 6 ticks
 * and 5 minutes of each other are one group row, which the chart marks while it is hovered or selected (D-69). A
 * signal is a fact about what the feed showed, never a recommendation.
 */
export function SignalsPanel({
  signals,
  spec,
  isKindOn,
  onToggleKind,
  floors,
  onFloors,
  fold,
  onHoverGroup,
  selectedGroup = null,
  onSelectGroup,
  rows: givenRows,
}: SignalsPanelProps) {
  const counts = countByKind(signals);
  const hidden = countHiddenByFloors(signals, floors);
  const ownRows = useSignalRows(givenRows ? null : signals, isKindOn, floors);
  const rows = givenRows ?? ownRows;
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
          {rows.map((row) => {
            if (row.type !== "group") return <MemberRowView key={memberKey(row)} row={row} spec={spec} />;
            const key = row.group.key;
            return (
              <GroupRowView
                key={key}
                group={row.group}
                spec={spec}
                selected={key === selectedGroup}
                onHover={onHoverGroup}
                onSelect={onSelectGroup}
              />
            );
          })}
        </ol>
      )}
    </SidePanel>
  );
}
