import { describe, expect, it } from "vitest";

import type { Signal } from "../api/schemas.ts";
import { formatPercent } from "./format.ts";
import {
  chainClusters,
  countHiddenByFloors,
  GROUP_MS,
  GROUP_TICKS,
  groupMark,
  ICEBERG_INFERRED_NOTE,
  listedGroupMarks,
  noFloors,
  passesFloors,
  reuseRows,
  signalRows,
  withoutIcebergNote,
  type IcebergFloors,
  type SignalGroup,
  type SignalRow,
} from "./signalClusters.ts";

// reference: REQUIREMENTS.md FR-80, FR-82, FR-62, FR-52, FR-9

const T0 = 1_794_000_000_000;
let nextId = 1;

/** A synthetic iceberg signal; `side` sets the bias the server gives it (bid → Bullish). */
function iceberg(
  priceTicks: number,
  timeMs: number,
  { side = "bid", strength = 0.5, hidden = 10 }: { side?: "bid" | "offer"; strength?: number; hidden?: number | null } = {},
): Signal {
  return {
    id: nextId++,
    kind: "Iceberg",
    bias: side === "bid" ? "Bullish" : "Bearish",
    timeMs,
    priceTicks,
    priceHighTicks: priceTicks,
    strength,
    label: side === "bid" ? "Inferred bid iceberg" : "Inferred offer iceberg",
    detail: `20 traded against at most 10 shown, 3 refills (avg 4); hidden ≥ ${hidden ?? 0}. ${ICEBERG_INFERRED_NOTE}`,
    ...(hidden == null ? {} : { hiddenEstimate: hidden }),
  };
}

function stacked(priceTicks: number, timeMs: number, strength = 0.1): Signal {
  return {
    id: nextId++,
    kind: "StackedImbalance",
    bias: "Bullish",
    timeMs,
    priceTicks,
    priceHighTicks: priceTicks + 3,
    strength,
    label: "Stacked buy imbalance",
    detail: "4 consecutive ticks at 3.5× diagonal",
  };
}

/** A synthetic liquidity sweep across a few ticks. */
function sweep(priceTicks: number, timeMs: number, strength = 0.7): Signal {
  return {
    id: nextId++,
    kind: "LiquiditySweep",
    bias: "Bearish",
    timeMs,
    priceTicks,
    priceHighTicks: priceTicks + 2,
    strength,
    label: "Offer sweep (inferred)",
    detail: "3 levels taken in 200 ms",
  };
}

const sideOf = (signal: Signal) => `${signal.kind}:${signal.bias}`;
const on = () => true;

describe("chainClusters", () => {
  it("should join a run whose each member is within 4 ticks and 60 s of the previous one, however far the ends drift", () => {
    const run = [iceberg(100, T0), iceberg(104, T0 + 60_000), iceberg(108, T0 + 120_000)];

    expect(chainClusters(run, sideOf, 4, 60_000)).toEqual([run]);
  });

  it("should start a new cluster when the next member is 5 ticks from the previous one", () => {
    const [a, b] = [iceberg(100, T0), iceberg(105, T0 + 1_000)];

    expect(chainClusters([a!, b!], sideOf, 4, 60_000)).toEqual([[a], [b]]);
  });

  it("should start a new cluster when the next member is more than 60 s after the previous one", () => {
    const [a, b] = [iceberg(100, T0), iceberg(100, T0 + 60_001)];

    expect(chainClusters([a!, b!], sideOf, 4, 60_000)).toEqual([[a], [b]]);
  });

  it("should keep the bid and offer sides apart when they are at the same price and time", () => {
    const [bid, offer] = [iceberg(100, T0), iceberg(100, T0, { side: "offer" })];

    expect(chainClusters([bid!, offer!], sideOf, 4, 60_000)).toEqual([[bid], [offer]]);
  });

  it("should leave an item on its own when its group is null", () => {
    const [a, b] = [stacked(100, T0), stacked(100, T0 + 1_000)];

    expect(chainClusters([a!, b!], () => null, 4, 60_000)).toEqual([[a], [b]]);
  });

  it("should add a member to the cluster whose previous member is newest when two clusters could take it", () => {
    const older = iceberg(100, T0);
    const newer = iceberg(106, T0 + 10_000);
    const between = iceberg(103, T0 + 20_000);

    expect(chainClusters([older, newer, between], sideOf, 4, 60_000)).toEqual([[older], [newer, between]]);
  });
});

describe("chainClusters reaching across a whole run", () => {
  const any = () => "any";

  it("should join items whose whole run stays within 6 ticks and 5 minutes", () => {
    const run = [stacked(100, T0), sweep(103, T0 + 100_000), iceberg(106, T0 + 300_000)];

    expect(chainClusters(run, any, 6, 300_000, "extent")).toEqual([run]);
  });

  it("should start a new run when an item one tick from the previous member would stretch the run past 6 ticks", () => {
    const [a, b, c] = [stacked(100, T0), sweep(106, T0 + 1_000), iceberg(107, T0 + 2_000)];

    expect(chainClusters([a!, b!, c!], any, 6, 300_000, "extent")).toEqual([[a, b], [c]]);
  });

  it("should measure the price reach below the run's first member too", () => {
    const [a, b, c] = [stacked(100, T0), sweep(94, T0 + 1_000), iceberg(101, T0 + 2_000)];

    expect(chainClusters([a!, b!, c!], any, 6, 300_000, "extent")).toEqual([[a, b], [c]]);
  });

  it("should start a new run when an item is more than 5 minutes after the run's first member, however recent the previous one", () => {
    const [a, b, c] = [stacked(100, T0), sweep(100, T0 + 290_000), iceberg(100, T0 + 300_001)];

    expect(chainClusters([a!, b!, c!], any, 6, 300_000, "extent")).toEqual([[a, b], [c]]);
  });

  it("should still chain on the previous member when no reach is given", () => {
    const run = [stacked(100, T0), sweep(106, T0 + 200_000), iceberg(112, T0 + 400_000)];

    expect(chainClusters(run, any, 6, 300_000)).toEqual([run]);
  });
});

/** The rule as D-66 states it, scanning every run a group opened: the reference the closing of idle runs must match. */
function unprunedClusters<T extends { timeMs: number; priceTicks: number }>(items: readonly T[], groupOf: (item: T) => string | null, maxTicks: number, maxMs: number): T[][] {
  const runs: { group: string | null; members: T[] }[] = [];
  for (const item of items) {
    const group = groupOf(item);
    let best: { group: string | null; members: T[] } | undefined;
    for (const run of group === null ? [] : runs) {
      const previous = run.members[run.members.length - 1];
      if (run.group !== group || !previous) continue;
      const near = Math.abs(item.priceTicks - previous.priceTicks) <= maxTicks && Math.abs(item.timeMs - previous.timeMs) <= maxMs;
      const bestPrevious = best?.members[best.members.length - 1];
      if (near && (!bestPrevious || previous.timeMs >= bestPrevious.timeMs)) best = run;
    }
    if (best) best.members.push(item);
    else runs.push({ group, members: [item] });
  }
  return runs.map((run) => run.members);
}

/** A deterministic random walk of both sides and two kinds, about the issue's 100 icebergs and 17 others an hour. */
function walk(count: number, meanGapMs = 30_770): Signal[] {
  let seed = 180;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const out: Signal[] = [];
  let timeMs = T0;
  let price = 20_000;
  for (let i = 0; i < count; i++) {
    timeMs += Math.round(meanGapMs * (0.2 + next() * 1.6));
    price += Math.round((next() - 0.5) * 12);
    out.push(next() < 0.85 ? iceberg(price, timeMs, { side: next() < 0.5 ? "bid" : "offer" }) : stacked(price, timeMs));
  }
  return out;
}

/** The whole-run rule, scanning every run ever opened: the reference the closing of old runs must match. */
function unprunedExtents<T extends { timeMs: number; priceTicks: number }>(items: readonly T[], maxTicks: number, maxMs: number): T[][] {
  const runs: T[][] = [];
  for (const item of items) {
    let best: T[] | undefined;
    for (const run of runs) {
      const prices = [...run.map((member) => member.priceTicks), item.priceTicks];
      const fits = Math.max(...prices) - Math.min(...prices) <= maxTicks && item.timeMs - (run[0]?.timeMs ?? item.timeMs) <= maxMs;
      const previous = run[run.length - 1];
      const bestPrevious = best?.[best.length - 1];
      if (fits && previous && (!bestPrevious || previous.timeMs >= bestPrevious.timeMs)) best = run;
    }
    if (best) best.push(item);
    else runs.push([item]);
  }
  return runs;
}

describe("chainClusters over a long history", () => {
  it("should give the same whole-run groups as scanning every run ever opened when old runs are closed", () => {
    const signals = walk(3_000, 5_000);

    expect(chainClusters(signals, () => "any", GROUP_TICKS, GROUP_MS, "extent")).toEqual(unprunedExtents(signals, GROUP_TICKS, GROUP_MS));
  });

  it("should not read more times per item as the history grows across whole runs, because a run older than 5 minutes is closed", () => {
    const readsPerItem = (count: number) => {
      let reads = 0;
      const counted = walk(count, 5_000).map((signal) => {
        const { timeMs, ...rest } = signal;
        return {
          ...rest,
          get timeMs() {
            reads++;
            return timeMs;
          },
        };
      });
      chainClusters(counted, () => "any", GROUP_TICKS, GROUP_MS, "extent");
      return reads / count;
    };

    // Bounded by how many runs began in the last 5 minutes; scanning every run ever opened grows with the count.
    expect(readsPerItem(4_000) / readsPerItem(1_000)).toBeLessThan(1.3);
  });

  it("should give the same runs as scanning every run ever opened when idle runs are closed", () => {
    const signals = walk(3_000);

    expect(chainClusters(signals, sideOf, 4, 60_000)).toEqual(unprunedClusters(signals, sideOf, 4, 60_000));
  });

  it("should read each item's time a bounded number of times, because a run idle longer than 60 s is closed", () => {
    let reads = 0;
    const counted = walk(2_000).map((signal) => {
      const { timeMs, ...rest } = signal;
      return {
        ...rest,
        get timeMs() {
          reads++;
          return timeMs;
        },
      };
    });

    chainClusters(counted, sideOf, 4, 60_000);

    // About 3 reads an item when idle runs close; scanning every run ever opened is about 44 here, growing with the history.
    expect(reads).toBeLessThan(counted.length * 5);
  });
});

describe("passesFloors", () => {
  const floors = (minStrengthPercent: number, minHiddenSize: number): IcebergFloors => ({ minStrengthPercent, minHiddenSize });

  it("should keep every iceberg when both floors are 0", () => {
    expect(passesFloors(iceberg(100, T0, { strength: 0, hidden: 0 }), noFloors)).toBe(true);
  });

  it("should keep an iceberg at the strength floor and hide one that reads a whole percent below it", () => {
    expect(passesFloors(iceberg(100, T0, { strength: 0.35 }), floors(35, 0))).toBe(true);
    expect(passesFloors(iceberg(100, T0, { strength: 0.344 }), floors(35, 0))).toBe(false);
  });

  it("should keep an iceberg whose hidden lower bound meets the size floor and hide one below it", () => {
    expect(passesFloors(iceberg(100, T0, { hidden: 25 }), floors(0, 25))).toBe(true);
    expect(passesFloors(iceberg(100, T0, { hidden: 24 }), floors(0, 25))).toBe(false);
  });

  it("should keep an iceberg that carries no hidden estimate when only the size floor is set", () => {
    expect(passesFloors(iceberg(100, T0, { hidden: null }), floors(0, 25))).toBe(true);
  });

  it("should keep an iceberg that the panel shows at the floor's whole percent, because the floor compares what is shown", () => {
    const shownAsForty = iceberg(100, T0, { strength: 0.395 });

    expect(formatPercent(shownAsForty.strength)).toBe("40 %");
    expect(passesFloors(shownAsForty, floors(40, 0))).toBe(true);
  });

  it("should hide an iceberg the panel shows one whole percent below the floor", () => {
    const shownAsThirtyNine = iceberg(100, T0, { strength: 0.394 });

    expect(formatPercent(shownAsThirtyNine.strength)).toBe("39 %");
    expect(passesFloors(shownAsThirtyNine, floors(40, 0))).toBe(false);
  });

  it("should agree with the shown percent for every strength in steps of 0.001", () => {
    for (let step = 0; step <= 1_000; step++) {
      const strength = step / 1_000;
      const shown = Number.parseInt(formatPercent(strength), 10);
      for (const floor of [shown - 1, shown, shown + 1]) {
        expect(passesFloors(iceberg(100, T0, { strength }), floors(floor, 0)), `${strength} against ${floor}`).toBe(shown >= floor);
      }
    }
  });

  it("should never hide another kind, whatever the floors", () => {
    expect(passesFloors(stacked(100, T0, 0.01), floors(100, 100_000))).toBe(true);
  });
});

describe("countHiddenByFloors", () => {
  it("should count, per kind, the events the floors hide", () => {
    const signals = [iceberg(100, T0, { strength: 0.3 }), iceberg(120, T0, { strength: 0.9 }), iceberg(140, T0, { hidden: 2 }), stacked(100, T0)];

    const hidden = countHiddenByFloors(signals, { minStrengthPercent: 40, minHiddenSize: 5 });

    expect(hidden.get("Iceberg")).toBe(2);
    expect(hidden.has("StackedImbalance")).toBe(false);
  });

  it("should count nothing when both floors are 0", () => {
    expect(countHiddenByFloors([iceberg(100, T0, { strength: 0 })], noFloors).size).toBe(0);
  });
});

describe("signalRows", () => {
  it("should list a lone iceberg as an ordinary row", () => {
    const lone = iceberg(100, T0);

    expect(signalRows([lone], on, noFloors)).toEqual([{ type: "single", signal: lone }]);
  });

  it("should fold neighbouring icebergs into one row with their range, count, summed hidden size and strongest member", () => {
    const a = iceberg(100, T0, { strength: 0.4, hidden: 10 });
    const b = iceberg(103, T0 + 30_000, { strength: 0.8, hidden: 25 });
    const c = iceberg(101, T0 + 50_000, { strength: 0.5, hidden: 5 });

    const rows = signalRows([a, b, c], on, noFloors);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      type: "cluster",
      cluster: {
        members: [c, b, a],
        lowTicks: 100,
        highTicks: 103,
        firstMs: T0,
        lastMs: T0 + 50_000,
        hiddenAtLeast: 40,
        strongest: b,
      },
    });
  });

  it("should sum only the members that carry a hidden estimate, and give none when no member does", () => {
    const known = signalRows([iceberg(100, T0, { hidden: 7 }), iceberg(101, T0 + 1_000, { hidden: null })], on, noFloors);
    const unknown = signalRows([iceberg(100, T0, { hidden: null }), iceberg(101, T0 + 1_000, { hidden: null })], on, noFloors);

    expect(known[0]?.type === "cluster" && known[0].cluster.hiddenAtLeast).toBe(7);
    expect(unknown[0]?.type === "cluster" && unknown[0].cluster.hiddenAtLeast).toBeNull();
  });

  it("should take the newest of equally strong members as the strongest", () => {
    const first = iceberg(100, T0, { strength: 0.6 });
    const second = iceberg(101, T0 + 1_000, { strength: 0.6 });

    const [row] = signalRows([first, second], on, noFloors);

    expect(row?.type === "cluster" && row.cluster.strongest).toBe(second);
  });

  it("should cluster only the icebergs the floors keep, so a hidden member can split a run", () => {
    const a = iceberg(100, T0, { strength: 0.9 });
    const weak = iceberg(104, T0 + 30_000, { strength: 0.2 });
    const c = iceberg(108, T0 + 60_000, { strength: 0.9 });

    const rows = signalRows([a, weak, c], on, { minStrengthPercent: 50, minHiddenSize: 0 });

    expect(rows).toEqual([
      { type: "single", signal: c },
      { type: "single", signal: a },
    ]);
  });

  it("should keep bid and offer icebergs in separate rows when they are at the same price and time", () => {
    const [bid, offer] = [iceberg(100, T0), iceberg(100, T0, { side: "offer" })];

    expect(signalRows([bid!, offer!], on, noFloors)).toEqual([
      { type: "single", signal: offer },
      { type: "single", signal: bid },
    ]);
  });

  it("should never fold other kinds, even at the same place and time", () => {
    const [a, b] = [stacked(100, T0), stacked(100, T0)];

    expect(signalRows([a!, b!], on, noFloors)).toEqual([
      { type: "single", signal: b },
      { type: "single", signal: a },
    ]);
  });

  it("should list rows newest first by their newest member and stop at the limit", () => {
    const cluster = [iceberg(100, T0), iceberg(101, T0 + 40_000)];
    const lone = stacked(300, T0 + 20_000);
    const latest = stacked(500, T0 + 50_000);

    const rows = signalRows([cluster[0]!, lone, cluster[1]!, latest], on, noFloors, 2);

    expect(rows.map((row) => (row.type === "single" ? row.signal.id : row.type === "cluster" ? row.cluster.lastMs : row.group.lastMs))).toEqual([latest.id, T0 + 40_000]);
  });

  it("should leave out a kind whose toggle is off", () => {
    expect(signalRows([iceberg(100, T0), stacked(100, T0)], (kind) => kind !== "Iceberg", noFloors)).toEqual([
      { type: "single", signal: expect.objectContaining({ kind: "StackedImbalance" }) },
    ]);
  });
});

describe("signalRows grouping co-located kinds", () => {
  const groupOf = (row: SignalRow | undefined): SignalGroup => {
    if (row?.type !== "group") throw new Error(`expected a group row, got ${row?.type ?? "nothing"}`);
    return row.group;
  };

  it("should show a sweep, a stacked imbalance and an iceberg within 6 ticks and 5 minutes as one group row", () => {
    const a = sweep(100, T0, 0.72);
    const b = stacked(101, T0 + 60_000, 0.55);
    const c = iceberg(106, T0 + 200_000, { strength: 0.61 });

    const rows = signalRows([a, b, c], on, noFloors);

    expect(rows).toHaveLength(1);
    const group = groupOf(rows[0]);
    expect(group.members).toEqual([
      { type: "single", signal: c },
      { type: "single", signal: b },
      { type: "single", signal: a },
    ]);
    expect(group.kinds).toEqual([
      { kind: "LiquiditySweep", count: 1, strongest: 0.72 },
      { kind: "StackedImbalance", count: 1, strongest: 0.55 },
      { kind: "Iceberg", count: 1, strongest: 0.61 },
    ]);
    expect(group).toMatchObject({ count: 3, lowTicks: 100, highTicks: 106, firstMs: T0, lastMs: T0 + 200_000 });
  });

  it("should carry no direction of its own, only its members", () => {
    const rows = signalRows([sweep(100, T0), stacked(101, T0 + 1_000)], on, noFloors);

    const group = groupOf(rows[0]);
    expect(Object.keys(group).sort()).toEqual(["count", "firstMs", "highTicks", "key", "kinds", "lastMs", "lowTicks", "members"]);
    expect(group.kinds.flatMap((kind) => Object.keys(kind))).not.toContain("bias");
  });

  it("should take the range's top from a member's high tick, as other rows do", () => {
    const group = groupOf(signalRows([iceberg(100, T0), stacked(102, T0 + 1_000)], on, noFloors)[0]);

    expect([group.lowTicks, group.highTicks]).toEqual([100, 105]);
  });

  it("should group kinds exactly 6 ticks apart and leave them apart at 7", () => {
    expect(signalRows([sweep(100, T0), stacked(106, T0 + 1_000)], on, noFloors)[0]?.type).toBe("group");
    expect(signalRows([sweep(100, T0), stacked(107, T0 + 1_000)], on, noFloors).map((row) => row.type)).toEqual(["single", "single"]);
  });

  it("should group kinds exactly 5 minutes apart and leave them apart 1 ms later", () => {
    expect(signalRows([sweep(100, T0), stacked(100, T0 + 300_000)], on, noFloors)[0]?.type).toBe("group");
    expect(signalRows([sweep(100, T0), stacked(100, T0 + 300_001)], on, noFloors).map((row) => row.type)).toEqual(["single", "single"]);
  });

  it("should not group signals of one kind, however close", () => {
    const rows = signalRows([sweep(100, T0), sweep(100, T0 + 1_000), sweep(101, T0 + 2_000)], on, noFloors);

    expect(rows.map((row) => row.type)).toEqual(["single", "single", "single"]);
  });

  it("should hold a cluster of icebergs as one member of the group", () => {
    const a = iceberg(100, T0, { strength: 0.4 });
    const b = iceberg(101, T0 + 20_000, { strength: 0.9 });
    const s = sweep(102, T0 + 40_000);

    const group = groupOf(signalRows([a, b, s], on, noFloors)[0]);

    expect(group.members.map((member) => member.type)).toEqual(["single", "cluster"]);
    expect(group.members[1]?.type === "cluster" && group.members[1].cluster.members).toEqual([b, a]);
    expect(group.kinds).toEqual([
      { kind: "Iceberg", count: 2, strongest: 0.9 },
      { kind: "LiquiditySweep", count: 1, strongest: 0.7 },
    ]);
  });

  it("should list one kind's run as its ordinary rows and clusters when no other kind joins it", () => {
    expect(signalRows([iceberg(100, T0), iceberg(101, T0 + 20_000)], on, noFloors).map((row) => row.type)).toEqual(["cluster"]);
  });

  it("should dissolve the group into its members' own rows when a kind's toggle turns off", () => {
    const a = sweep(100, T0);
    const b = stacked(101, T0 + 1_000);

    expect(signalRows([a, b], (kind) => kind !== "LiquiditySweep", noFloors)).toEqual([{ type: "single", signal: b }]);
  });

  it("should keep the other kinds grouped when one of three is turned off", () => {
    const group = groupOf(signalRows([sweep(100, T0), stacked(101, T0 + 1_000), iceberg(102, T0 + 2_000)], (kind) => kind !== "Iceberg", noFloors)[0]);

    expect(group.kinds.map((kind) => kind.kind)).toEqual(["LiquiditySweep", "StackedImbalance"]);
  });

  it("should not let an iceberg below the floors make a group", () => {
    const rows = signalRows([iceberg(100, T0, { strength: 0.2 }), sweep(101, T0 + 1_000)], on, { minStrengthPercent: 50, minHiddenSize: 0 });

    expect(rows.map((row) => row.type)).toEqual(["single"]);
  });

  it("should sort a group among other rows by its newest member and count it as one row toward the limit", () => {
    const early = stacked(500, T0);
    const grouped = [sweep(100, T0 + 10_000), stacked(101, T0 + 30_000)];
    const late = stacked(900, T0 + 20_000);

    const rows = signalRows([early, grouped[0]!, late, grouped[1]!], on, noFloors, 2);

    expect(rows.map((row) => row.type)).toEqual(["group", "single"]);
    expect(rows[1]?.type === "single" && rows[1].signal).toBe(late);
  });

  it("should key a group on its first signal in time when the ids run against time, and widen its range when a newer kind joins", () => {
    // Created newest first, so the ids run against time: the key follows time, not the smallest id.
    const later = stacked(103, T0 + 30_000);
    const s = sweep(102, T0 + 20_000);
    const b = iceberg(101, T0 + 10_000);
    const a = iceberg(100, T0);

    const before = groupMark(groupOf(signalRows([a, b, s], on, noFloors)[0]));
    const after = groupMark(groupOf(signalRows([a, b, s, later], on, noFloors)[0]));

    expect(before).toEqual({ key: `group-${a.id}`, lowTicks: 100, highTicks: 104 });
    expect(after).toEqual({ key: `group-${a.id}`, lowTicks: 100, highTicks: 106 });
  });

  // reference: review 5985119089 on a separate change a separate change
  it("should keep a group's key when a later iceberg clusters with its first signal and that cluster sorts first", () => {
    const a = iceberg(100, T0);
    const s = sweep(101, T0 + 10_000);
    const b = iceberg(104, T0 + 20_000);

    const before = groupOf(signalRows([a, s], on, noFloors)[0]);
    const after = groupOf(signalRows([a, s, b], on, noFloors)[0]);

    expect(after.members.map((member) => member.type)).toEqual(["cluster", "single"]);
    expect(before.key).toBe(`group-${a.id}`);
    expect(after.key).toBe(`group-${a.id}`);
    expect(groupMark(after)).toEqual({ key: `group-${a.id}`, lowTicks: 100, highTicks: 104 });
  });

  it("should resolve the listed groups' marks by key, and nothing for a key no listed group has", () => {
    const a = sweep(100, T0);
    const rows = signalRows([a, stacked(101, T0 + 1_000), sweep(300, T0 + 2_000)], on, noFloors);

    const marks = listedGroupMarks(rows);

    expect([...marks.values()]).toEqual([{ key: `group-${a.id}`, lowTicks: 100, highTicks: 104 }]);
    expect(marks.get("group-0")).toBeUndefined();
  });

  it("should list two groups at one price as two rows when more than 5 minutes separate them", () => {
    const rows = signalRows([sweep(100, T0), stacked(100, T0 + 1_000), sweep(100, T0 + 400_000), stacked(100, T0 + 401_000)], on, noFloors);

    expect(rows.map((row) => row.type)).toEqual(["group", "group"]);
  });
});

describe("withoutIcebergNote", () => {
  it("should drop the inferred sentence from an iceberg's detail and keep the evidence", () => {
    expect(withoutIcebergNote(iceberg(100, T0, { hidden: 12 }))).toBe("20 traded against at most 10 shown, 3 refills (avg 4); hidden ≥ 12.");
  });

  it("should leave a detail that does not carry the sentence as it is", () => {
    const other = stacked(100, T0);

    expect(withoutIcebergNote(other)).toBe(other.detail);
    expect(withoutIcebergNote({ ...other, kind: "Iceberg" })).toBe(other.detail);
  });

  it("should leave the sentence on another kind's detail, because only icebergs carry the note once", () => {
    const other = { ...stacked(100, T0), detail: `Something else. ${ICEBERG_INFERRED_NOTE}` };

    expect(withoutIcebergNote(other)).toBe(other.detail);
  });
});

describe("reuseRows", () => {
  const rowsOf = (signals: Signal[]) => signalRows(signals, on, noFloors);

  it("should keep a row whose signals are the same objects", () => {
    const signals = [iceberg(100, T0), iceberg(101, T0 + 1_000)];
    const before = rowsOf(signals);

    expect(reuseRows(before, rowsOf(signals))[0]).toBe(before[0]);
  });

  it("should not keep a row whose signals only share ids with it, as after a server restart", () => {
    const [a, b] = [iceberg(100, T0), iceberg(101, T0 + 1_000)];
    const before = rowsOf([a, b]);
    const restarted = rowsOf([{ ...a }, { ...b }]);

    expect(reuseRows(before, restarted)[0]).toBe(restarted[0]);
  });

  it("should not keep a cluster when only its oldest member is another object under the same id", () => {
    const [a, b] = [iceberg(100, T0), iceberg(101, T0 + 1_000)];
    const before = rowsOf([a, b]);
    const next = rowsOf([{ ...a, label: "Other" }, b]);

    expect(reuseRows(before, next)[0]).toBe(next[0]);
  });
});
