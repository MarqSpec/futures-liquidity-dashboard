import type { Signal } from "../api/schemas.ts";

// reference: REQUIREMENTS.md FR-80, FR-62; ARCHITECTURE.md D-66

/** Icebergs on one side join a cluster within this many ticks of the previous member (the ruling, Q2 A). */
export const ICEBERG_CLUSTER_TICKS = 4;

/** …and within this long after it. */
export const ICEBERG_CLUSTER_MS = 60_000;

/** The sentence the server ends every iceberg's detail with. The Signals panel shows it once, not on every row. */
export const ICEBERG_INFERRED_NOTE = "Inferred from prints and book changes, not exchange order ids.";

/** The Signals panel's iceberg floors, from the saved layout. Display only: nothing upstream is filtered. */
export interface IcebergFloors {
  /** Whole percent, 0–100, compared with the signal's strength. */
  readonly minStrengthPercent: number;
  /** Contracts, compared with the signal's hidden lower bound. */
  readonly minHiddenSize: number;
}

/** Floors that hide nothing. */
export const noFloors: IcebergFloors = { minStrengthPercent: 0, minHiddenSize: 0 };

/**
 * Whether the floors let a signal through. Only icebergs are floored. An iceberg with no hidden estimate (an older
 * server) is judged on strength alone, because a size it does not report cannot be shown to fall short.
 */
export function passesFloors(signal: Signal, floors: IcebergFloors): boolean {
  if (signal.kind !== "Iceberg") return true;
  if (signal.strength < floors.minStrengthPercent / 100) return false;
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
 * Groups items, in time order, into runs: an item joins a run of its own group when it is within `maxTicks` and
 * `maxMs` of that run's previous member, so a run can drift further than either distance end to end. When two runs
 * could take it, the one whose previous member is newest does. A run closes once it has been idle longer than
 * `maxMs`, so a long history costs about one scan of the runs still open per item. An item whose group is null stays
 * on its own.
 * Runs come back in the order they started, each oldest member first.
 */
export function chainClusters<T extends ClusterItem>(
  items: readonly T[],
  groupOf: (item: T) => string | null,
  maxTicks: number,
  maxMs: number,
): T[][] {
  const runs: T[][] = [];
  const open = new Map<string, T[][]>();
  for (const item of items) {
    const group = groupOf(item);
    if (group === null) {
      runs.push([item]);
      continue;
    }
    // In time order a run idle longer than maxMs can take no later item, so it is closed rather than scanned again.
    const candidates = (open.get(group) ?? []).filter((run) => item.timeMs - (run[run.length - 1]?.timeMs ?? item.timeMs) <= maxMs);
    open.set(group, candidates);
    let best: T[] | undefined;
    for (const run of candidates) {
      const previous = run[run.length - 1];
      if (!previous) continue;
      const near = Math.abs(item.priceTicks - previous.priceTicks) <= maxTicks && Math.abs(item.timeMs - previous.timeMs) <= maxMs;
      const bestPrevious = best?.[best.length - 1];
      if (near && (!bestPrevious || previous.timeMs >= bestPrevious.timeMs)) best = run;
    }
    if (best) {
      best.push(item);
    } else {
      const run = [item];
      runs.push(run);
      candidates.push(run);
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

/** One row of the Signals panel. */
export type SignalRow = { readonly type: "single"; readonly signal: Signal } | { readonly type: "cluster"; readonly cluster: SignalCluster };

function icebergSide(signal: Signal): string | null {
  return signal.kind === "Iceberg" ? `${signal.kind}:${signal.bias}` : null;
}

function summarise(run: readonly Signal[]): SignalRow {
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

function newestMs(row: SignalRow): number {
  return row.type === "single" ? row.signal.timeMs : row.cluster.lastMs;
}

/**
 * The panel's rows, newest first by their newest member, at most `limit`: the signals of the kinds `isOn` accepts
 * that pass the floors, with icebergs on one side folded into clusters (`ICEBERG_CLUSTER_TICKS`, `ICEBERG_CLUSTER_MS`).
 * Other kinds are one row each. `signals` is in time order, as the server keeps them (ARCHITECTURE.md D-41).
 */
export function signalRows(
  signals: readonly Signal[],
  isOn: (kind: string) => boolean,
  floors: IcebergFloors,
  limit = Number.POSITIVE_INFINITY,
): SignalRow[] {
  const shown = signals.filter((signal) => isOn(signal.kind) && passesFloors(signal, floors));
  const rows = chainClusters(shown, icebergSide, ICEBERG_CLUSTER_TICKS, ICEBERG_CLUSTER_MS).map(summarise);
  // Stable, so rows of one time keep their arrival order before the reverse puts the later one first.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => newestMs(b.row) - newestMs(a.row) || b.index - a.index)
    .slice(0, limit)
    .map(({ row }) => row);
}

/** An iceberg's detail without the closing inferred sentence the panel shows once; any other detail as it is. */
export function withoutIcebergNote(signal: Signal): string {
  if (signal.kind !== "Iceberg" || !signal.detail.endsWith(ICEBERG_INFERRED_NOTE)) return signal.detail;
  return signal.detail.slice(0, -ICEBERG_INFERRED_NOTE.length).trimEnd();
}
