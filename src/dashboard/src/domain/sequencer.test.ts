import { describe, expect, it } from "vitest";

import { emptyDelta, snapshotFixture } from "../test/fixtures.ts";
import { awaitSnapshot, receiveDelta, receiveSnapshot, type StreamPhase } from "./sequencer.ts";

const snapshot = snapshotFixture();
const s = snapshot.seq;

function live(): StreamPhase {
  return receiveSnapshot(awaitSnapshot("ES"), snapshot, 5, 0).phase;
}

function seqOf(phase: StreamPhase): number | null {
  return phase.kind === "live" ? phase.state.seq : null;
}

describe("receiveDelta", () => {
  it("should buffer a delta when the snapshot has not arrived", () => {
    const step = receiveDelta(awaitSnapshot("ES"), emptyDelta(s + 1), 0);

    expect(step.phase.kind === "awaiting-snapshot" && step.phase.buffered).toHaveLength(1);
  });

  it("should apply the delta when its seq is the next one", () => {
    expect(seqOf(receiveDelta(live(), emptyDelta(s + 1), 0).phase)).toBe(s + 1);
  });

  it("should drop the delta when its seq is at or below the state's", () => {
    const step = receiveDelta(live(), emptyDelta(s), 0);

    expect(seqOf(step.phase)).toBe(s);
  });

  it("should ask for a resync when a seq is skipped", () => {
    expect(receiveDelta(live(), emptyDelta(s + 2), 0).resync).toBe(true);
  });

  it("should wait for a new snapshot when a seq is skipped", () => {
    expect(receiveDelta(live(), emptyDelta(s + 2), 0).phase.kind).toBe("awaiting-snapshot");
  });

  it("should ignore a delta for another instrument when it arrives after a switch", () => {
    const phase = live();

    expect(receiveDelta(phase, emptyDelta(s + 1, "GC"), 0).phase).toBe(phase);
  });
});

describe("receiveSnapshot", () => {
  it("should drop buffered deltas at or below the snapshot's seq when it lands", () => {
    let phase = awaitSnapshot("ES");
    for (const seq of [s - 1, s, s + 1, s + 2]) {
      phase = receiveDelta(phase, emptyDelta(seq), 0).phase;
    }

    expect(seqOf(receiveSnapshot(phase, snapshot, 5, 0).phase)).toBe(s + 2);
  });

  it("should apply buffered deltas in seq order when they arrived out of order", () => {
    let phase = awaitSnapshot("ES");
    for (const seq of [s + 2, s + 1]) {
      phase = receiveDelta(phase, emptyDelta(seq), 0).phase;
    }

    expect(receiveSnapshot(phase, snapshot, 5, 0).resync).toBe(false);
  });

  it("should ask for a resync when the buffered deltas leave a gap after the snapshot", () => {
    const phase = receiveDelta(awaitSnapshot("ES"), emptyDelta(s + 3), 0).phase;

    expect(receiveSnapshot(phase, snapshot, 5, 0).resync).toBe(true);
  });

  it("should go live when nothing was buffered", () => {
    expect(seqOf(receiveSnapshot(awaitSnapshot("ES"), snapshot, 5, 0).phase)).toBe(s);
  });
});
