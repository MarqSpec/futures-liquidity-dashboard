import { describe, expect, it, vi } from "vitest";

import type { HubState, MarketConnection } from "../lib/signalr.ts";
import { subscribeUnauthorized } from "../lib/apiKey.ts";
import { indicatorsForViewer } from "../domain/merge.ts";
import { emptyDelta, rawSnapshot, snapshotFixture } from "../test/fixtures.ts";
import { snapshotSchema } from "./schemas.ts";
import { MarketStream } from "./marketStream.ts";

/** A hub that answers Subscribe with the fixture snapshot and lets the test push deltas and state changes. */
function fakeHub() {
  let deltaHandler: (payload: unknown) => void = () => undefined;
  let snapshotHandler: (payload: unknown) => void = () => undefined;
  let stateHandler: (state: HubState, error: string | null) => void = () => undefined;
  let state: HubState = "disconnected";
  const connection: MarketConnection = {
    start: vi.fn(async () => {
      state = "connected";
      stateHandler("connected", null);
    }),
    stop: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => rawSnapshot),
    unsubscribe: vi.fn(async () => undefined),
    setWatchlist: vi.fn(async (roots: readonly string[]): Promise<unknown> => ({
      depth: roots.filter((r) => r !== "NG"),
      refused: roots.filter((r) => r === "NG"),
    })),
    onDelta: (handler) => {
      deltaHandler = handler;
    },
    onSnapshot: (handler) => {
      snapshotHandler = handler;
    },
    onState: (handler) => {
      stateHandler = handler;
    },
    state: () => state,
  };
  return {
    connection,
    push: (payload: unknown) => deltaHandler(payload),
    pushSnapshot: (payload: unknown) => snapshotHandler(payload),
    setState: (next: HubState) => {
      state = next;
      stateHandler(next, null);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const seq = snapshotFixture().seq;

async function started(watchlist: readonly string[] = ["ES", "GC"]) {
  const hub = fakeHub();
  const stream = new MarketStream(hub.connection, () => 0, () => () => undefined);
  stream.select("ES", 5);
  stream.watch(watchlist);
  stream.start();
  await flush();
  return { hub, stream };
}

describe("MarketStream", () => {
  it("should subscribe to the selected instrument when the hub connects", async () => {
    const { hub } = await started();

    expect(hub.connection.subscribe).toHaveBeenCalledWith("ES", 5, 1);
  });

  it("should resubscribe for a snapshot of the new indicator timeframe when it changes", async () => {
    const hub = fakeHub();
    hub.connection.subscribe = vi.fn(async (_instrument: string, _history: number, indicatorMinutes = 1) => {
      const parsed = snapshotSchema.parse(rawSnapshot);
      return { ...parsed, indicators: parsed.indicators.map((series) => ({ ...series, tf: indicatorMinutes * 60 })) };
    });
    const stream = new MarketStream(hub.connection, () => 0, () => () => undefined);
    stream.select("ES", 5, 1);
    stream.start();
    await flush();

    expect(hub.connection.subscribe).toHaveBeenCalledWith("ES", 5, 1);
    expect(stream.getView().market?.indicators.every((series) => series.tf === 60)).toBe(true);

    stream.select("ES", 5, 15);
    await flush();

    expect(hub.connection.unsubscribe).not.toHaveBeenCalled();
    expect(hub.connection.subscribe).toHaveBeenLastCalledWith("ES", 5, 15);
    const switched = stream.getView().market;
    expect(switched?.indicators.every((series) => series.tf === 900)).toBe(true);
    expect(stream.getView().awaitingSnapshot).toBe(false);

    const ema = switched?.indicators.find((series) => series.id === "ema10");
    const last = ema?.points.at(-1)?.[0] ?? 0;
    const point = [last + 60_000, 2];
    hub.push({
      ...emptyDelta((switched?.seq ?? 0) + 1),
      indicators: (switched?.indicators ?? []).map((series) => ({ ...series, points: [point] })),
    });

    const after = stream.getView().market;
    expect(after?.seq).toBe((switched?.seq ?? 0) + 1);
    expect(after?.indicators.every((series) => series.tf === 900)).toBe(true);
    expect(after?.indicators.find((series) => series.id === "ema10")?.points.at(-1)).toEqual(point);
    expect(stream.getView().resyncs).toBe(0);
  });

  it("should not draw the previous timeframe while the new snapshot is still outstanding", async () => {
    const pending: { resolve: (payload: unknown) => void } = { resolve: () => undefined };
    const hub = fakeHub();
    hub.connection.subscribe = vi.fn(
      (_instrument: string, _history: number, indicatorMinutes = 1) =>
        new Promise<unknown>((resolve) => {
          const parsed = snapshotSchema.parse(rawSnapshot);
          const payload = {
            ...parsed,
            indicators: parsed.indicators.map((series) => ({ ...series, tf: indicatorMinutes * 60 })),
          };
          if (indicatorMinutes === 1) {
            resolve(payload);
            return;
          }
          pending.resolve = resolve;
        }),
    );
    const stream = new MarketStream(hub.connection, () => 0, () => () => undefined);
    stream.select("ES", 5, 1);
    stream.start();
    await flush();

    stream.select("ES", 5, 15);

    const held = stream.getView().market?.indicators ?? [];
    expect(stream.getView().awaitingSnapshot).toBe(true);
    expect(stream.getView().market?.root).toBe("ES");
    expect(indicatorsForViewer(held, 15).some((series) => series.tf === 60)).toBe(false);
    expect(indicatorsForViewer(held, 15)).toEqual([]);

    const parsed = snapshotSchema.parse(rawSnapshot);
    pending.resolve({ ...parsed, indicators: parsed.indicators.map((series) => ({ ...series, tf: 900 })) });
    await flush();
    expect(stream.getView().market?.indicators.every((series) => series.tf === 900)).toBe(true);
  });

  it("should ignore a catch-up snapshot for a different indicator timeframe", async () => {
    const hub = fakeHub();
    hub.connection.subscribe = vi.fn(async (_instrument: string, _history: number, indicatorMinutes = 1) => {
      const parsed = snapshotSchema.parse(rawSnapshot);
      return { ...parsed, indicators: parsed.indicators.map((series) => ({ ...series, tf: indicatorMinutes * 60 })) };
    });
    const stream = new MarketStream(hub.connection, () => 0, () => () => undefined);
    stream.select("ES", 5, 15);
    stream.start();
    await flush();
    const selected = stream.getView().market;
    expect(selected?.indicators.every((series) => series.tf === 900)).toBe(true);

    const oneMinute = snapshotSchema.parse(rawSnapshot);
    hub.pushSnapshot({ ...oneMinute, seq: selected?.seq ?? 0 });
    hub.pushSnapshot({ ...oneMinute, seq: (selected?.seq ?? 0) + 4 });

    expect(stream.getView().market?.seq).toBe(selected?.seq);
    expect(stream.getView().market?.indicators.every((series) => series.tf === 900)).toBe(true);
    expect(stream.getView().resyncs).toBe(0);

    const ema = selected?.indicators.find((series) => series.id === "ema10");
    const last = ema?.points.at(-1)?.[0] ?? 0;
    const point = [last + 60_000, 3];
    hub.push({
      ...emptyDelta((selected?.seq ?? 0) + 1),
      indicators: (selected?.indicators ?? []).map((series) => ({ ...series, points: [point] })),
    });

    const after = stream.getView().market;
    expect(after?.seq).toBe((selected?.seq ?? 0) + 1);
    expect(after?.indicators.every((series) => series.tf === 900)).toBe(true);
    expect(after?.indicators.find((series) => series.id === "ema10")?.points.at(-1)).toEqual(point);
  });

  it("should keep an already selected indicator timeframe when only the history window changes", async () => {
    const { hub, stream } = await started();
    stream.select("ES", 5, 15);
    await flush();
    stream.select("ES", 30, 15);
    await flush();

    expect(hub.connection.unsubscribe).not.toHaveBeenCalled();
    expect(hub.connection.subscribe).toHaveBeenNthCalledWith(2, "ES", 5, 15);
    expect(hub.connection.subscribe).toHaveBeenNthCalledWith(3, "ES", 30, 15);
  });

  it("should not resubscribe when the instrument, history and indicator timeframe are unchanged", async () => {
    const { hub, stream } = await started();
    stream.select("ES", 5, 1);

    expect(hub.connection.subscribe).toHaveBeenCalledTimes(1);
  });

  it("should show the snapshot's state when the subscribe returns", async () => {
    const { stream } = await started();

    expect(stream.getView().market?.seq).toBe(seq);
  });

  it("should apply twenty contiguous deltas without a resync when none is missing", async () => {
    const { hub, stream } = await started();
    for (let i = 1; i <= 20; i++) {
      hub.push(emptyDelta(seq + i));
    }

    expect([stream.getView().market?.seq, stream.getView().resyncs]).toEqual([seq + 20, 0]);
  });

  it("should re-subscribe when a delta is missing", async () => {
    const timers: { callback: () => void; ms: number }[] = [];
    const hub = fakeHub();
    const stream = new MarketStream(hub.connection, () => 0, (callback, ms) => {
      timers.push({ callback, ms });
      return () => undefined;
    });
    stream.select("ES", 5);
    stream.start();
    await flush();
    hub.push(emptyDelta(seq + 2));

    expect(hub.connection.subscribe).toHaveBeenCalledTimes(1);
    expect(timers.at(-1)?.ms).toBe(2000);
    timers.at(-1)?.callback();
    await flush();
    expect(hub.connection.subscribe).toHaveBeenCalledTimes(2);
  });

  it("should wait longer before a second gap resubscribe", async () => {
    const timers: { callback: () => void; ms: number }[] = [];
    const hub = fakeHub();
    const stream = new MarketStream(hub.connection, () => 0, (callback, ms) => {
      timers.push({ callback, ms });
      return () => undefined;
    });
    stream.select("ES", 5);
    stream.start();
    await flush();
    hub.push(emptyDelta(seq + 2));
    const first = timers.at(-1);
    expect(first?.ms).toBe(2000);
    first?.callback();
    await flush();

    expect(hub.connection.subscribe).toHaveBeenCalledTimes(2);
    expect(timers.at(-1)?.ms).toBe(4000);
  });

  it("should ignore a pushed snapshot for another instrument or an older sequence", async () => {
    const { hub, stream } = await started();
    const current = snapshotSchema.parse(rawSnapshot);
    hub.pushSnapshot({ ...current, root: "GC", seq: current.seq + 5 });
    hub.pushSnapshot({ ...current, seq: current.seq - 1 });

    expect(stream.getView().market?.root).toBe("ES");
    expect(stream.getView().market?.seq).toBe(seq);
  });

  it("should apply a pushed snapshot for this instrument and clear a pending resubscribe", async () => {
    const timers: { callback: () => void; ms: number }[] = [];
    let cancelled = 0;
    const hub = fakeHub();
    const stream = new MarketStream(hub.connection, () => 0, (callback, ms) => {
      timers.push({ callback, ms });
      return () => {
        cancelled += 1;
      };
    });
    stream.select("ES", 5);
    stream.start();
    await flush();
    hub.push(emptyDelta(seq + 2));
    const current = snapshotSchema.parse(rawSnapshot);
    hub.pushSnapshot({ ...current, seq: seq + 2 });

    expect(cancelled).toBe(1);
    expect(timers).toHaveLength(1);
    expect(stream.getView().market?.seq).toBe(seq + 2);
    expect(hub.connection.subscribe).toHaveBeenCalledTimes(1);

    hub.push(emptyDelta(seq + 4));
    expect(timers.at(-1)?.ms).toBe(2000);
  });

  it("should re-subscribe when the hub reconnects", async () => {
    const { hub } = await started();
    hub.setState("reconnecting");
    hub.setState("connected");
    await flush();

    expect(hub.connection.subscribe).toHaveBeenCalledTimes(2);
  });

  it("should count and resync on a delta that fails the schema when the stream is live", async () => {
    const { hub, stream } = await started();
    hub.push({ seq: "not a number" });

    expect(stream.getView().rejectedDeltas).toBe(1);
  });

  it("should unsubscribe from the old instrument when another is selected", async () => {
    const { hub, stream } = await started();
    stream.select("GC", 5);

    expect(hub.connection.unsubscribe).toHaveBeenCalledWith("ES");
  });

  it("should clear the old instrument's state when another is selected", async () => {
    const { stream } = await started();
    stream.select("GC", 5);

    expect(stream.getView().market).toBeNull();
  });

  it("should send the watchlist when the hub connects", async () => {
    const { hub } = await started();

    expect(hub.connection.setWatchlist).toHaveBeenCalledWith(["ES", "GC"]);
  });

  it("should send the watchlist again when the hub reconnects", async () => {
    const { hub } = await started();
    hub.setState("reconnecting");
    hub.setState("connected");
    await flush();

    expect(hub.connection.setWatchlist).toHaveBeenCalledTimes(2);
  });

  it("should send the new watchlist when it changes while connected", async () => {
    const { hub, stream } = await started();
    stream.watch(["ES", "GC", "CL"]);

    expect(hub.connection.setWatchlist).toHaveBeenLastCalledWith(["ES", "GC", "CL"]);
  });

  it("should not send the watchlist again when an equal list is set", async () => {
    const { hub, stream } = await started();
    stream.watch(["ES", "GC"]);

    expect(hub.connection.setWatchlist).toHaveBeenCalledTimes(1);
  });

  it("should not send the watchlist while the hub is disconnected", () => {
    const hub = fakeHub();
    const stream = new MarketStream(hub.connection, () => 0, () => () => undefined);
    stream.watch(["ES"]);

    expect(hub.connection.setWatchlist).not.toHaveBeenCalled();
  });

  it("should show the roots the server refused depth for when it answers", async () => {
    const { stream } = await started(["ES", "NG"]);

    expect([stream.getView().depthRoots, stream.getView().refusedRoots]).toEqual([["ES"], ["NG"]]);
  });

  it("should show no refused root when the answer does not match the expected shape", async () => {
    const { hub, stream } = await started(["ES", "NG"]);
    vi.mocked(hub.connection.setWatchlist).mockResolvedValueOnce({ depth: "all" });
    stream.watch(["NG"]);
    await flush();

    expect(stream.getView().refusedRoots).toEqual([]);
  });

  it("should not reconnect and should report the rejection when the hub answers 401", async () => {
    let stateHandler: (state: HubState, error: string | null) => void = () => undefined;
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        stateHandler("disconnected", "Status code '401'");
        throw new Error("Status code '401'");
      }),
      stop: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => "disconnected",
    };
    const scheduled: number[] = [];
    const stream = new MarketStream(connection, () => 0, (_callback, ms) => {
      scheduled.push(ms);
      return () => undefined;
    });
    const rejected: string[] = [];
    const stop = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.start();
    await flush();
    stop();

    expect(scheduled).toEqual([]);
    expect(rejected).toEqual(["401"]);
    expect(stream.getView().error).toBe("The API key was rejected.");
  });

  it("should stop the connection and report unauthorized when a reconnect is rejected", async () => {
    let stateHandler: (state: HubState, error: string | null) => void = () => undefined;
    let state: HubState = "disconnected";
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        state = "connected";
        stateHandler("connected", null);
      }),
      stop: vi.fn(async () => {
        state = "disconnected";
        stateHandler("disconnected", null);
      }),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => state,
    };
    const scheduled: number[] = [];
    const stream = new MarketStream(connection, () => 0, (_callback, ms) => {
      scheduled.push(ms);
      return () => undefined;
    });
    const rejected: string[] = [];
    const stop = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.start();
    await flush();
    stateHandler("reconnecting", "Status code '401'");
    await flush();
    stop();

    expect(connection.stop).toHaveBeenCalledOnce();
    expect(rejected).toEqual(["401"]);
    expect(scheduled).toEqual([]);
    expect(stream.getView().hub).toBe("disconnected");
    expect(stream.getView().error).toBe("The API key was rejected.");
  });

  it("should retry a disconnect that is not a rejected key when no probe is configured", async () => {
    const scheduled: number[] = [];
    const hub = fakeHub();
    const stream = new MarketStream(hub.connection, () => 0, (_callback, ms) => {
      scheduled.push(ms);
      return () => undefined;
    });
    stream.start();
    await flush();
    hub.setState("disconnected");

    expect(scheduled).toEqual([3000]);
  });

  it("should stop retrying when a native probe says the key was rejected", async () => {
    let state: HubState = "disconnected";
    let stateHandler: (state: HubState, error: string | null) => void = () => undefined;
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        state = "disconnected";
        stateHandler("disconnected", "WebSocket closed");
        throw new Error("WebSocket closed");
      }),
      stop: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => state,
    };
    const scheduled: number[] = [];
    const probe = vi.fn(async () => true);
    const stream = new MarketStream(
      connection,
      () => 0,
      (_callback, ms) => {
        scheduled.push(ms);
        return () => undefined;
      },
      probe,
    );
    const rejected: string[] = [];
    const stop = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.start();
    await flush();
    stateHandler("disconnected", "WebSocket closed again");
    await flush();
    stop();

    expect(probe).toHaveBeenCalledOnce();
    expect(scheduled).toEqual([]);
    expect(rejected).toEqual(["401"]);
    expect(stream.getView().error).toBe("The API key was rejected.");
    expect(stream.getView().hub).toBe("disconnected");
  });

  it("should stop a reconnecting hub when the probe says the key was rejected", async () => {
    let state: HubState = "disconnected";
    let stateHandler: (next: HubState, error: string | null) => void = () => undefined;
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        state = "connected";
        stateHandler("connected", null);
      }),
      stop: vi.fn(async () => {
        state = "disconnected";
        stateHandler("disconnected", null);
      }),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => state,
    };
    const scheduled: number[] = [];
    const stream = new MarketStream(
      connection,
      () => 0,
      (_callback, ms) => {
        scheduled.push(ms);
        return () => undefined;
      },
      async () => true,
    );
    const rejected: string[] = [];
    const stop = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.start();
    await flush();
    state = "reconnecting";
    stateHandler("reconnecting", "WebSocket closed");
    await flush();
    stop();

    expect(connection.stop).toHaveBeenCalledOnce();
    expect(rejected).toEqual(["401"]);
    expect(scheduled).toEqual([]);
    expect(stream.getView().hub).toBe("disconnected");
  });

  it("should keep retrying when the probe says the key is still accepted", async () => {
    let state: HubState = "disconnected";
    let stateHandler: (next: HubState, error: string | null) => void = () => undefined;
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        state = "disconnected";
        stateHandler("disconnected", "network down");
        throw new Error("network down");
      }),
      stop: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => state,
    };
    const scheduled: number[] = [];
    const stream = new MarketStream(
      connection,
      () => 0,
      (_callback, ms) => {
        scheduled.push(ms);
        return () => undefined;
      },
      async () => false,
    );
    const rejected: string[] = [];
    const stop = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.start();
    await flush();
    stop();

    expect(scheduled).toEqual([3000]);
    expect(rejected).toEqual([]);
    expect(stream.getView().error).not.toBe("The API key was rejected.");
  });

  it("should connect again when start is called after the key was rejected", async () => {
    let stateHandler: (state: HubState, error: string | null) => void = () => undefined;
    let state: HubState = "disconnected";
    let attempts = 0;
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          stateHandler("disconnected", "Status code '401'");
          throw new Error("Status code '401'");
        }
        state = "connected";
        stateHandler("connected", null);
      }),
      stop: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => state,
    };
    const stream = new MarketStream(connection, () => 0, () => () => undefined);
    const rejected: string[] = [];
    const stop = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.select("ES", 5);
    stream.start();
    await flush();
    expect(stream.getView().error).toBe("The API key was rejected.");

    stream.start();
    await flush();
    stop();

    expect(attempts).toBe(2);
    expect(rejected).toEqual(["401"]);
    expect(connection.subscribe).toHaveBeenCalledWith("ES", 5, 1);
    expect(stream.getView().hub).toBe("connected");
    expect(stream.getView().error).toBeNull();
  });

  it("should not apply a subscribe snapshot older than the one already on screen", async () => {
    const pending: { resolve: (payload: unknown) => void } = { resolve: () => undefined };
    const hub = fakeHub();
    let calls = 0;
    hub.connection.subscribe = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(rawSnapshot);
      }
      return new Promise((resolve) => {
        pending.resolve = resolve;
      });
    });
    const stream = new MarketStream(hub.connection, () => 0, () => () => undefined);
    stream.select("ES", 5);
    stream.start();
    await flush();
    const current = snapshotSchema.parse(rawSnapshot);
    expect(stream.getView().market?.seq).toBe(current.seq);

    hub.setState("reconnecting");
    hub.setState("connected");
    await flush();
    expect(calls).toBe(2);
    hub.pushSnapshot({ ...current, seq: current.seq + 5 });
    expect(stream.getView().market?.seq).toBe(current.seq + 5);

    pending.resolve({ ...current, seq: current.seq });
    await flush();

    expect(stream.getView().market?.seq).toBe(current.seq + 5);
    expect(stream.getView().resyncs).toBe(0);
  });

  it("should apply a subscribe snapshot with a lower seq when the hub reconnects", async () => {
    const pending: { resolve: (payload: unknown) => void } = { resolve: () => undefined };
    const hub = fakeHub();
    let calls = 0;
    hub.connection.subscribe = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(rawSnapshot);
      }
      return new Promise((resolve) => {
        pending.resolve = resolve;
      });
    });
    const stream = new MarketStream(hub.connection, () => 0, () => () => undefined);
    stream.select("ES", 5);
    stream.start();
    await flush();
    const current = snapshotSchema.parse(rawSnapshot);
    expect(stream.getView().market?.seq).toBe(current.seq);

    hub.setState("reconnecting");
    hub.setState("connected");
    await flush();
    pending.resolve({ ...current, seq: 1 });
    await flush();

    expect(stream.getView().market?.seq).toBe(1);
    expect(stream.getView().awaitingSnapshot).toBe(false);
  });

  it("should not report unauthorized when a 401 close arrives after stop resolves", async () => {
    let state: HubState = "disconnected";
    let stateHandler: (next: HubState, error: string | null) => void = () => undefined;
    let emitClose: () => void = () => undefined;
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        state = "connected";
        stateHandler("connected", null);
      }),
      stop: vi.fn(() => {
        const settled = Promise.resolve();
        emitClose = () => {
          state = "disconnected";
          stateHandler("disconnected", "Status code '401'");
        };
        return settled;
      }),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => state,
    };
    const stream = new MarketStream(connection, () => 0, () => () => undefined);
    const rejected: string[] = [];
    const stopListening = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.start();
    await flush();
    stream.stop();
    emitClose();
    await flush();
    stopListening();

    expect(rejected).toEqual([]);
    expect(stream.getView().error).not.toBe("The API key was rejected.");
  });

  it("should connect when the 401 close arrives after the replaced socket has stopped", async () => {
    let state: HubState = "disconnected";
    let stateHandler: (next: HubState, error: string | null) => void = () => undefined;
    let emitClose: () => void = () => undefined;
    let starts = 0;
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        starts += 1;
        state = "connected";
        stateHandler("connected", null);
      }),
      stop: vi.fn(() => {
        emitClose = () => {
          state = "disconnected";
          stateHandler("disconnected", "Status code '401'");
        };
        return Promise.resolve();
      }),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => state,
    };
    const stream = new MarketStream(connection, () => 0, () => () => undefined);
    const rejected: string[] = [];
    const stopListening = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.select("ES", 5);
    stream.start();
    await flush();
    state = "reconnecting";
    stateHandler("reconnecting", "Status code '401'");
    await flush();
    expect(stream.getView().error).toBe("The API key was rejected.");
    expect(rejected).toEqual(["401"]);

    stream.start();
    await flush();
    emitClose();
    await flush();
    stopListening();

    expect(rejected).toEqual(["401"]);
    expect(stream.getView().error).toBeNull();
    expect(stream.getView().hub).toBe("connected");
    expect(starts).toBe(2);
  });

  it("should not treat a key probe that finishes after stop as a rejection", async () => {
    let resolveProbe: (rejected: boolean) => void = () => undefined;
    let state: HubState = "disconnected";
    let stateHandler: (next: HubState, error: string | null) => void = () => undefined;
    const scheduled: number[] = [];
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        state = "disconnected";
        stateHandler("disconnected", "WebSocket closed");
        throw new Error("WebSocket closed");
      }),
      stop: vi.fn(async () => {
        resolveProbe(true);
      }),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => state,
    };
    const probe = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveProbe = resolve;
    }));
    const stream = new MarketStream(
      connection,
      () => 0,
      (_callback, ms) => {
        scheduled.push(ms);
        return () => undefined;
      },
      probe,
    );
    const rejected: string[] = [];
    const stopListening = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.start();
    await flush();
    expect(probe).toHaveBeenCalledOnce();
    stream.stop();
    await flush();
    stopListening();

    expect(rejected).toEqual([]);
    expect(scheduled).toEqual([]);
    expect(stream.getView().error).not.toBe("The API key was rejected.");
  });

  it("should connect again when start is called while a connecting 401 is still closing", async () => {
    let state: HubState = "disconnected";
    let stateHandler: (next: HubState, error: string | null) => void = () => undefined;
    let finishStop: () => void = () => undefined;
    let stopping: Promise<void> | null = null;
    const connection: MarketConnection = {
      start: vi.fn(async () => {
        state = "connected";
        stateHandler("connected", null);
      }),
      stop: vi.fn(() => {
        stopping ??= new Promise<void>((resolve) => {
          finishStop = () => {
            state = "disconnected";
            stateHandler("disconnected", "Status code '401'");
            resolve();
          };
        });
        return stopping;
      }),
      subscribe: vi.fn(async () => rawSnapshot),
      unsubscribe: vi.fn(async () => undefined),
      setWatchlist: vi.fn(async () => ({ depth: [], refused: [] })),
      onDelta: () => undefined,
      onSnapshot: () => undefined,
      onState: (handler) => {
        stateHandler = handler;
      },
      state: () => state,
    };
    const stream = new MarketStream(connection, () => 0, () => () => undefined);
    const rejected: string[] = [];
    const stopListening = subscribeUnauthorized(() => {
      rejected.push("401");
    });

    stream.select("ES", 5);
    stream.start();
    await flush();
    state = "connecting";
    stateHandler("connecting", "Status code '401'");
    expect(stream.getView().error).toBe("The API key was rejected.");
    expect(connection.stop).toHaveBeenCalledOnce();

    stream.start();
    finishStop();
    await flush();

    expect(stream.getView().error).toBeNull();
    expect(stream.getView().hub).toBe("connected");
    expect(connection.subscribe).toHaveBeenCalledTimes(2);

    stateHandler("disconnected", "Status code '401'");
    await flush();
    stopListening();

    expect(rejected).toEqual(["401", "401"]);
    expect(stream.getView().error).toBe("The API key was rejected.");
    expect(stream.getView().hub).toBe("disconnected");
  });
});
