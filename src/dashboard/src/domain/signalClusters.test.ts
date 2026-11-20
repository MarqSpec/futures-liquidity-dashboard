import { describe, expect, it } from "vitest";

import type { Signal } from "../api/schemas.ts";
import {
  chainClusters,
  countHiddenByFloors,
  ICEBERG_INFERRED_NOTE,
  noFloors,
  passesFloors,
  signalRows,
  withoutIcebergNote,
  type IcebergFloors,
} from "./signalClusters.ts";

// reference: REQUIREMENTS.md FR-80, FR-62, FR-52, FR-9

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
function walk(count: number): Signal[] {
  let seed = 180;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const out: Signal[] = [];
  let timeMs = T0;
  let price = 20_000;
  for (let i = 0; i < count; i++) {
    timeMs += Math.round(30_770 * (0.2 + next() * 1.6));
    price += Math.round((next() - 0.5) * 12);
    out.push(next() < 0.85 ? iceberg(price, timeMs, { side: next() < 0.5 ? "bid" : "offer" }) : stacked(price, timeMs));
  }
  return out;
}

describe("chainClusters over a long history", () => {
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

  it("should keep an iceberg at the strength floor and hide one just below it", () => {
    expect(passesFloors(iceberg(100, T0, { strength: 0.35 }), floors(35, 0))).toBe(true);
    expect(passesFloors(iceberg(100, T0, { strength: 0.349 }), floors(35, 0))).toBe(false);
  });

  it("should keep an iceberg whose hidden lower bound meets the size floor and hide one below it", () => {
    expect(passesFloors(iceberg(100, T0, { hidden: 25 }), floors(0, 25))).toBe(true);
    expect(passesFloors(iceberg(100, T0, { hidden: 24 }), floors(0, 25))).toBe(false);
  });

  it("should keep an iceberg that carries no hidden estimate when only the size floor is set", () => {
    expect(passesFloors(iceberg(100, T0, { hidden: null }), floors(0, 25))).toBe(true);
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

    expect(rows.map((row) => (row.type === "single" ? row.signal.id : row.cluster.lastMs))).toEqual([latest.id, T0 + 40_000]);
  });

  it("should leave out a kind whose toggle is off", () => {
    expect(signalRows([iceberg(100, T0), stacked(100, T0)], (kind) => kind !== "Iceberg", noFloors)).toEqual([
      { type: "single", signal: expect.objectContaining({ kind: "StackedImbalance" }) },
    ]);
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
