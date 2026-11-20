import type { Signal } from "../api/schemas.ts";
import { wholePercent } from "./format.ts";

// reference: REQUIREMENTS.md FR-80, FR-82, FR-62; ARCHITECTURE.md D-66, D-69

/** Icebergs on one side join a cluster within this many ticks of the previous member (the ruling, Q2 A). */
export const ICEBERG_CLUSTER_TICKS = 4;

/** …and within this long after it. */
export const ICEBERG_CLUSTER_MS = 60_000;

/** Signals of two or more kinds form a group when the whole group spans at most this many ticks (the ruling, Q1 A)… */
export const GROUP_TICKS = 6;

/** …and at most this long from its first member to its last. */
export const GROUP_MS = 300_000;

/** The most rows the Signals panel lists. */
export const SIGNAL_LIST_LIMIT = 200;

/** The most members an opened group or cluster lists; the rest are a "+N more" line. */
export const MEMBER_LIST_LIMIT = 50;

/** The sentence the server ends every iceberg's detail with. The Signals panel shows it once, not on every row. */
export const ICEBERG_INFERRED_NOTE = "Inferred from prints and book changes, not exchange order ids.";

/** The Signals panel's iceberg floors, from the saved layout. Display only: nothing upstream is filtered. */
export interface IcebergFloors {
  /** Whole percent, 0–100, compared with the whole percent the row shows for the signal's strength. */
  readonly minStrengthPercent: number;
  /** Contracts, compared with the signal's hidden lower bound. */
  readonly minHiddenSize: number;
}

/** Floors that hide nothing. */
export const noFloors: IcebergFloors = { minStrengthPercent: 0, minHiddenSize: 0 };

// — the floor compares the whole percent the row shows, so the floor and the display agree
/**
 * Whether the floors let a signal through. Only icebergs are floored. Strength is compared as the whole percent the row
 * shows, so an iceberg read as "40 %" passes a 40 floor. An iceberg with no hidden estimate (an older server) is judged
 * on strength alone, because a size it does not report cannot be shown to fall short.
 */
export function passesFloors(signal: Signal, floors: IcebergFloors): boolean {
  if (signal.kind !== "Iceberg") return true;
  if (wholePercent(signal.strength) < floors.minStrengthPercent) return false;
  return signal.hiddenEstimate == null || signal.hiddenEstimate >= floors.minHiddenSize;
}

/** How many signals of each kind the floors hide. A kind with none hidden is absent. */
export function countHiddenByFloors(signals: readonly Signal[], floors: IcebergFloors): ReadonlyMap<string, number> {
  const hidden = new Map<string, number>();
  for (const signal of signals) {
    if (!passesFloors(signal, floors)) hidden.set(signal.kind, (hidden.get(signal.kind) ?? 0) + 1);
  }
  return hidden;
}

/** What `chainClusters` reads from an item. */
export interface ClusterItem {
  readonly timeMs: number;
  readonly priceTicks: number;
}

/**
 * How far a run reaches: `"previous"` measures an item against the run's previous member, so a run can drift further
 * than either distance end to end (D-66); `"extent"` measures the whole run with the item added, so every member lies
 * within `maxTicks` and `maxMs` of every other (D-69).
 */
export type ClusterReach = "previous" | "extent";

interface OpenRun<T> {
  readonly members: T[];
  readonly firstMs: number;
  low: number;
  high: number;
}

/**
 * Groups items, in time order, into runs of one group each: an item joins a run of its own group when it is within
 * `maxTicks` and `maxMs` as `reach` measures. When two runs could take it, the one whose previous member is newest
 * does. A run closes once no later item could join it (idle longer than `maxMs`, or, for `"extent"`, begun longer than
 * `maxMs` ago), so a long history costs about one scan of the runs still open per item. An item whose group is null
 * stays on its own.
 * Runs come back in the order they started, each oldest member first.
 */
export function chainClusters<T extends ClusterItem>(
  items: readonly T[],
  groupOf: (item: T) => string | null,
  maxTicks: number,
  maxMs: number,
  reach: ClusterReach = "previous",
): T[][] {
  const runs: T[][] = [];
  const open = new Map<string, OpenRun<T>[]>();
  const extent = reach === "extent";
  for (const item of items) {
    const group = groupOf(item);
    if (group === null) {
      runs.push([item]);
      continue;
    }
    const timeMs = item.timeMs;
    const price = item.priceTicks;
    // In time order a run no later item can join is closed rather than scanned again. For "extent" this is also the
    // time bound: every run still open began at most maxMs before this item.
    const candidates = (open.get(group) ?? []).filter(
      (run) => timeMs - (extent ? run.firstMs : (run.members[run.members.length - 1]?.timeMs ?? timeMs)) <= maxMs,
    );
    open.set(group, candidates);
    let best: OpenRun<T> | undefined;
    let bestMs = Number.NEGATIVE_INFINITY;
    for (const run of candidates) {
      const previous = run.members[run.members.length - 1];
      if (!previous) continue;
      const previousMs = previous.timeMs;
      const near = extent
        ? Math.max(run.high, price) - Math.min(run.low, price) <= maxTicks
        : Math.abs(price - previous.priceTicks) <= maxTicks && Math.abs(timeMs - previousMs) <= maxMs;
      if (near && (!best || previousMs >= bestMs)) {
        best = run;
        bestMs = previousMs;
      }
    }
    if (best) {
      best.members.push(item);
      best.low = Math.min(best.low, price);
      best.high = Math.max(best.high, price);
    } else {
      const members = [item];
      runs.push(members);
      candidates.push({ members, firstMs: timeMs, low: price, high: price });
    }
  }
  return runs;
}

/** Neighbouring icebergs shown as one row. */
export interface SignalCluster {
  /** Newest first, as the panel lists them. */
  readonly members: readonly Signal[];
  readonly lowTicks: number;
  readonly highTicks: number;
  readonly firstMs: number;
  readonly lastMs: number;
  /** The members' hidden lower bounds summed, itself a lower bound; null when no member reports one. */
  readonly hiddenAtLeast: number | null;
  /** The highest strength, the newest of equals. */
  readonly strongest: Signal;
}

/** A row that stands alone or sits inside a group: one signal, or a cluster of icebergs. */
export type MemberRow = { readonly type: "single"; readonly signal: Signal } | { readonly type: "cluster"; readonly cluster: SignalCluster };

/** One kind present in a group: how many of its signals the group holds and the strongest one's strength. */
export interface GroupKind {
  readonly kind: string;
  readonly count: number;
  readonly strongest: number;
}

/**
 * Signals of two or more kinds within `GROUP_TICKS` and `GROUP_MS` of each other, shown as one row. It describes where
 * they coincide and carries no direction of its own: each member keeps its own bias and strength (Q2 A).
 */
export interface SignalGroup {
  /** Names the group while it grows: `group-<id>` of its first signal in time. */
  readonly key: string;
  /** Its rows, newest first, an iceberg cluster being one row. */
  readonly members: readonly MemberRow[];
  /** The kinds present, in the order each first appeared. */
  readonly kinds: readonly GroupKind[];
  /** How many signals it holds. */
  readonly count: number;
  readonly lowTicks: number;
  readonly highTicks: number;
  readonly firstMs: number;
  readonly lastMs: number;
}

/** One row of the Signals panel. */
export type SignalRow = MemberRow | { readonly type: "group"; readonly group: SignalGroup };

/** What the chart marks for a hovered or selected group: its price range, under a key that names it while it grows. */
export interface GroupMark {
  readonly key: string;
  readonly lowTicks: number;
  readonly highTicks: number;
}

/** A group's mark: its key and its current price range. */
export function groupMark(group: SignalGroup): GroupMark {
  return { key: group.key, lowTicks: group.lowTicks, highTicks: group.highTicks };
}

/** The marks of the groups among `rows`, by key: what a held key resolves to while its group is listed. */
export function listedGroupMarks(rows: readonly SignalRow[]): ReadonlyMap<string, GroupMark> {
  const marks = new Map<string, GroupMark>();
  for (const row of rows) if (row.type === "group") marks.set(row.group.key, groupMark(row.group));
  return marks;
}

function icebergSide(signal: Signal): string | null {
  return signal.kind === "Iceberg" ? `${signal.kind}:${signal.bias}` : null;
}

function summarise(run: readonly Signal[]): MemberRow {
  const [only] = run;
  if (run.length === 1 && only) return { type: "single", signal: only };
  let strongest = run[0] as Signal;
  let hidden: number | null = null;
  for (const member of run) {
    if (member.strength >= strongest.strength) strongest = member;
    if (member.hiddenEstimate != null) hidden = (hidden ?? 0) + member.hiddenEstimate;
  }
  return {
    type: "cluster",
    cluster: {
      members: [...run].reverse(),
      lowTicks: Math.min(...run.map((member) => member.priceTicks)),
      highTicks: Math.max(...run.map((member) => member.priceHighTicks)),
      firstMs: run[0]?.timeMs ?? 0,
      lastMs: run[run.length - 1]?.timeMs ?? 0,
      hiddenAtLeast: hidden,
      strongest,
    },
  };
}

/** A group not yet summarised: only the rows the panel lists are built (`signalRows`' limit). */
interface GroupRun {
  readonly type: "run";
  readonly run: readonly Signal[];
  readonly kinds: readonly GroupKind[];
}

function newestMs(row: SignalRow | GroupRun): number {
  switch (row.type) {
    case "single":
      return row.signal.timeMs;
    case "cluster":
      return row.cluster.lastMs;
    case "group":
      return row.group.lastMs;
    case "run":
      return row.run[row.run.length - 1]?.timeMs ?? 0;
  }
}

/** Newest first by each row's newest member. Stable, so rows of one time keep their arrival order before the reverse. */
function newestFirst<R extends SignalRow | GroupRun>(rows: readonly R[]): R[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => newestMs(b.row) - newestMs(a.row) || b.index - a.index)
    .map(({ row }) => row);
}

/** Icebergs on one side folded into clusters; every other signal a row of its own. */
function memberRows(signals: readonly Signal[]): MemberRow[] {
  return chainClusters(signals, icebergSide, ICEBERG_CLUSTER_TICKS, ICEBERG_CLUSTER_MS).map(summarise);
}

function kindsOf(run: readonly Signal[]): GroupKind[] {
  const kinds = new Map<string, { count: number; strongest: number }>();
  for (const signal of run) {
    const seen = kinds.get(signal.kind);
    if (seen) {
      seen.count++;
      seen.strongest = Math.max(seen.strongest, signal.strength);
    } else {
      kinds.set(signal.kind, { count: 1, strongest: signal.strength });
    }
  }
  return [...kinds].map(([kind, { count, strongest }]) => ({ kind, count, strongest }));
}

function groupRow(run: readonly Signal[], kinds: readonly GroupKind[]): SignalRow {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const member of run) {
    low = Math.min(low, member.priceTicks);
    high = Math.max(high, member.priceHighTicks);
  }
  return {
    type: "group",
    group: {
      // The run is in time order, so its first signal stays first however the member rows sort.
      key: `group-${run[0]?.id ?? 0}`,
      members: newestFirst(memberRows(run)),
      kinds,
      count: run.length,
      lowTicks: low,
      highTicks: high,
      firstMs: run[0]?.timeMs ?? 0,
      lastMs: run[run.length - 1]?.timeMs ?? 0,
    },
  };
}

const anyKind = (): string => "any";

function memberIds(row: MemberRow): string {
  return row.type === "single" ? `${row.signal.id}` : `(${row.cluster.members.map((member) => member.id).join(",")})`;
}

/**
 * What a row is made of: the ids of the signals it lists, in order. A cheap key to find the previous row to compare
 * with; it does not prove the rows equal, because ids restart from 1 in each server process (`reuseRows` checks the
 * signals themselves).
 */
export function rowSignature(row: SignalRow): string {
  switch (row.type) {
    case "single":
      return `s:${row.signal.id}`;
    case "cluster":
      return `c:${memberIds(row)}`;
    case "group":
      return `g:${row.group.key}:${row.group.members.map(memberIds).join(";")}`;
  }
}

function memberSignals(row: MemberRow): readonly Signal[] {
  return row.type === "single" ? [row.signal] : row.cluster.members;
}

/** Every signal a row lists, in the order `rowSignature` names them. */
function rowSignals(row: SignalRow): readonly Signal[] {
  return row.type === "group" ? row.group.members.flatMap(memberSignals) : memberSignals(row);
}

/**
 * Whether two rows list the very same `Signal` objects, member by member. Identity, not id: the stream keeps a signal's
 * object across deltas (`appendNew` and `retainSignals` pass existing items through), so an unchanged row matches, while
 * a snapshot after a reconnect parses new objects, so a signal that merely reuses an id from a restarted server never does.
 */
function sameSignals(a: SignalRow, b: SignalRow): boolean {
  const left = rowSignals(a);
  const right = rowSignals(b);
  return left.length === right.length && left.every((signal, index) => signal === right[index]);
}

/**
 * `next`, with each row replaced by the equal row of `previous` when there is one, so an unchanged row keeps its
 * identity. A row is equal when its signature matches and its members are the same `Signal` objects.
 */
export function reuseRows(previous: readonly SignalRow[], next: readonly SignalRow[]): SignalRow[] {
  const before = new Map(previous.map((row) => [rowSignature(row), row]));
  return next.map((row) => {
    const old = before.get(rowSignature(row));
    return old && sameSignals(old, row) ? old : row;
  });
}

/**
 * The panel's rows, newest first by their newest member, at most `limit`: the signals of the kinds `isOn` accepts
 * that pass the floors. Signals of two or more kinds whose whole run spans at most `GROUP_TICKS` and `GROUP_MS` are one
 * group row (D-69); a run of one kind is not a group. Outside groups, and inside each, icebergs on one side fold into
 * clusters (`ICEBERG_CLUSTER_TICKS`, `ICEBERG_CLUSTER_MS`) and other signals are one row each. `signals` is in time
 * order, as the server keeps them (ARCHITECTURE.md D-41).
 */
export function signalRows(
  signals: readonly Signal[],
  isOn: (kind: string) => boolean,
  floors: IcebergFloors,
  limit = Number.POSITIVE_INFINITY,
): SignalRow[] {
  const shown = signals.filter((signal) => isOn(signal.kind) && passesFloors(signal, floors));
  const rows: (SignalRow | GroupRun)[] = [];
  const grouped = new Set<Signal>();
  for (const run of chainClusters(shown, anyKind, GROUP_TICKS, GROUP_MS, "extent")) {
    const kinds = kindsOf(run);
    if (kinds.length < 2) continue;
    rows.push({ type: "run", run, kinds });
    for (const member of run) grouped.add(member);
  }
  rows.push(...memberRows(grouped.size === 0 ? shown : shown.filter((signal) => !grouped.has(signal))));
  return newestFirst(rows)
    .slice(0, limit)
    .map((row) => (row.type === "run" ? groupRow(row.run, row.kinds) : row));
}

/** An iceberg's detail without the closing inferred sentence the panel shows once; any other detail as it is. */
export function withoutIcebergNote(signal: Signal): string {
  if (signal.kind !== "Iceberg" || !signal.detail.endsWith(ICEBERG_INFERRED_NOTE)) return signal.detail;
  return signal.detail.slice(0, -ICEBERG_INFERRED_NOTE.length).trimEnd();
}
