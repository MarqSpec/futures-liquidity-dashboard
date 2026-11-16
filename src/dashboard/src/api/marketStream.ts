import { reportUnauthorized } from "../lib/apiKey.ts";
import { isHubUnauthorized, type HubState, type MarketConnection } from "../lib/signalr.ts";
import { indicatorsForViewer, type MarketState } from "../domain/merge.ts";
import { awaitSnapshot, receiveDelta, receiveSnapshot, type StreamPhase, type StreamStep } from "../domain/sequencer.ts";
import { deltaSchema, snapshotSchema, watchlistResultSchema } from "./schemas.ts";

/** What the dashboard renders from the stream. */
export interface StreamView {
  readonly hub: HubState;
  /** The current instrument's state; null until its first snapshot (and after switching instrument). */
  readonly market: MarketState | null;
  /** True while a (re)subscribe is waiting for its snapshot. */
  readonly awaitingSnapshot: boolean;
  readonly error: string | null;
  /** How many times a sequence gap, reconnect or bad payload forced a fresh snapshot. */
  readonly resyncs: number;
  /** Deltas that failed the schema and were discarded. */
  readonly rejectedDeltas: number;
  /** The watched roots the server pulls depth for on this connection's behalf; null until it has answered. */
  readonly depthRoots: readonly string[] | null;
  /** The watched roots the server would not pull depth for: unknown, not permitted or over its depth cap. */
  readonly refusedRoots: readonly string[];
}

interface Selection {
  readonly instrument: string;
  readonly historyMinutes: number;
  /** 1, 5 or 15. The server sends only this indicator timeframe. */
  readonly indicatorMinutes: number;
}

const RESTART_MS = 3000;
const RETRY_SUBSCRIBE_MS = 2000;
const MAX_RESYNC_MS = 30_000;

/** True when a REST probe says the viewer key was rejected. A network failure is false, so the hub keeps retrying. */
export type KeyProbe = () => Promise<boolean>;

/**
 * Owns the hub connection and the ordering rules of INTERFACES.md D.2 for one selected instrument: subscribe,
 * buffer deltas until the snapshot, apply them in sequence, and re-subscribe on a gap or a reconnect. It also keeps
 * the server told of the viewer's watchlist (SetWatchlist), on every connect and whenever the list changes, so the
 * watched products' depth history builds up before the viewer switches to them.
 */
export class MarketStream {
  readonly #connection: MarketConnection;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, ms: number) => () => void;
  readonly #listeners = new Set<() => void>();
  #selection: Selection | null = null;
  #watchlist: readonly string[] | null = null;
  #watchToken = 0;
  #phase: StreamPhase | null = null;
  #token = 0;
  /**
   * The newest seq applied on this connection. Null after a fresh resubscribe until that connection's first
   * snapshot lands, so a restarted server whose seq begins again is accepted.
   */
  #seqFloor: number | null = null;
  #running = false;
  #rejected = false;
  #cancelTimer: (() => void) | null = null;
  #gapResyncs = 0;
  readonly #probe: KeyProbe | null;
  #probeToken = 0;
  #probing = false;
  /** Bumped by `start` and `stop` so a close from the attempt being replaced cannot connect or reject the next one. */
  #startGeneration = 0;
  /** True until the next `connection.start()` begins, so the close from `stop()` cannot reject that attempt. */
  #drainingStop = false;
  #view: StreamView = {
    hub: "disconnected",
    market: null,
    awaitingSnapshot: false,
    error: null,
    resyncs: 0,
    rejectedDeltas: 0,
    depthRoots: null,
    refusedRoots: [],
  };

  constructor(
    connection: MarketConnection,
    now: () => number = Date.now,
    schedule: (callback: () => void, ms: number) => () => void = (callback, ms) => {
      const id = setTimeout(callback, ms);
      return () => clearTimeout(id);
    },
    probe: KeyProbe | null = null,
  ) {
    this.#connection = connection;
    this.#now = now;
    this.#schedule = schedule;
    this.#probe = probe;
    connection.onDelta((payload) => this.#onDelta(payload));
    connection.onSnapshot((payload) => this.#onSnapshot(payload));
    connection.onState((state, error) => this.#onState(state, error));
  }

  /** Connects, retrying until `stop`. */
  start(): void {
    if (this.#running) {
      return;
    }
    // A rejected key used to stick for the life of the instance. start() is a new attempt.
    // A 401 while connecting or reconnecting closes the socket afterwards. That close can still say 401.
    // Wait until it is disconnected, and do not treat the close as a rejection of this attempt.
    const generation = ++this.#startGeneration;
    const rejected = this.#rejected;
    this.#rejected = false;
    this.#probeToken += 1;
    this.#probing = false;
    this.#running = true;
    this.#clearTimer();
    if (rejected) {
      this.#update({ error: null });
    }
    if (this.#connection.state() !== "disconnected") {
      this.#drainingStop = true;
      void this.#connection.stop().finally(() => {
        if (generation !== this.#startGeneration || !this.#running) {
          return;
        }
        // The flag stays set until start() below. A 401 close that follows stop() is the socket we replaced.
        this.#connect();
      });
      return;
    }
    this.#connect();
  }

  /** Disconnects and stops retrying. */
  stop(): void {
    // An in-flight key probe must not reject, or schedule a retry, after the viewer has left.
    this.#running = false;
    this.#clearTimer();
    this.#token++;
    this.#startGeneration += 1;
    this.#probeToken += 1;
    this.#probing = false;
    // The close that follows this stop can still say 401. Ignore it until a later start() calls the hub.
    this.#drainingStop = true;
    void this.#connection.stop().catch(() => undefined);
  }

  /**
   * Views `instrument` with `historyMinutes` of history and `indicatorMinutes` (1, 5 or 15) of indicator series.
   * Re-subscribes when any of them changes. A new timeframe asks for a fresh snapshot of that series and leaves
   * the open instrument subscribed, so the chart interval and the other layout choices do not reconnect.
   */
  select(instrument: string, historyMinutes: number, indicatorMinutes = 1): void {
    const previous = this.#selection;
    if (
      previous?.instrument === instrument &&
      previous.historyMinutes === historyMinutes &&
      previous.indicatorMinutes === indicatorMinutes
    ) {
      return;
    }
    this.#selection = { instrument, historyMinutes, indicatorMinutes };
    if (previous && previous.instrument !== instrument && this.#connection.state() === "connected") {
      void this.#connection.unsubscribe(previous.instrument).catch(() => undefined);
    }
    if (previous?.instrument !== instrument) {
      this.#seqFloor = null;
      this.#update({ market: null });
    } else if (previous.indicatorMinutes !== indicatorMinutes && this.#view.market?.root === instrument) {
      // The old series are the previous timeframe. Drawing them under the new choice is the wrong chart.
      this.#update({ market: { ...this.#view.market, indicators: [] } });
    }
    this.#resubscribe();
  }

  /** Watches `roots` (the server pulls their depth); tells the server now when connected, else on connect. */
  watch(roots: readonly string[]): void {
    const previous = this.#watchlist;
    if (previous && previous.length === roots.length && previous.every((root, i) => root === roots[i])) {
      return;
    }
    this.#watchlist = [...roots];
    this.#sendWatchlist();
  }

  /** Registers a change listener (the useSyncExternalStore contract); returns the unsubscribe function. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The current view; a new object after every change. */
  readonly getView = (): StreamView => this.#view;

  #update(patch: Partial<StreamView>): void {
    this.#view = { ...this.#view, ...patch };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #clearTimer(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  #connect(): void {
    this.#clearTimer();
    if (!this.#running || this.#connection.state() !== "disconnected") {
      return;
    }
    // Drop the drain only once this start begins, so a 401 from the socket stop() just closed cannot reject it.
    this.#drainingStop = false;
    this.#connection.start().catch(() => {
      // onState("disconnected") schedules the next attempt.
    });
  }

  #rejectKey(state: HubState): void {
    this.#rejected = true;
    this.#running = false;
    this.#clearTimer();
    this.#probeToken += 1;
    this.#probing = false;
    this.#update({ hub: "disconnected", error: "The API key was rejected." });
    reportUnauthorized();
    if (state !== "disconnected") {
      void this.#connection.stop().catch(() => undefined);
    }
  }

  /**
   * The native hub's WebSocket close has no HTTP status. One REST probe distinguishes a revoked key
   * from a down server, and a 401 stops the reconnect loop.
   */
  #awaitingKeyCheck(state: HubState): boolean {
    if (!this.#probe || !this.#running || this.#rejected) {
      return false;
    }
    if (state !== "disconnected" && state !== "reconnecting") {
      return false;
    }
    if (this.#probing) {
      return true;
    }
    const probe = this.#probe;
    const token = ++this.#probeToken;
    this.#probing = true;
    void probe().then(
      (rejected) => this.#afterKeyCheck(token, rejected),
      () => this.#afterKeyCheck(token, false),
    );
    return true;
  }

  #afterKeyCheck(token: number, rejected: boolean): void {
    if (token !== this.#probeToken) {
      return;
    }
    this.#probing = false;
    if (!this.#running || this.#rejected) {
      return;
    }
    if (rejected) {
      this.#rejectKey(this.#connection.state() === "disconnected" ? "disconnected" : "reconnecting");
      return;
    }
    if (this.#connection.state() === "disconnected") {
      this.#clearTimer();
      this.#cancelTimer = this.#schedule(() => this.#connect(), RESTART_MS);
    }
  }

  #onState(state: HubState, error: string | null): void {
    if (this.#drainingStop) {
      // The close belongs to the socket stop() replaced. A 401 here is not a rejection of the next attempt.
      if (this.#running && state === "disconnected" && this.#connection.state() === "disconnected") {
        this.#connect();
      }
      return;
    }
    // A 401 while reconnecting never becomes "disconnected" on its own: SignalR keeps retrying the negotiate.
    const unauthorized = !this.#rejected && isHubUnauthorized(error) && (state === "disconnected" || state === "reconnecting" || state === "connecting");
    if (unauthorized) {
      this.#rejectKey(state);
      return;
    }
    if (this.#rejected) {
      this.#update({ hub: "disconnected", error: "The API key was rejected." });
      return;
    }
    if (state === "connected") {
      this.#probeToken += 1;
      this.#probing = false;
    }
    this.#update({ hub: state, error: state === "disconnected" && error ? error : this.#view.error });
    if (this.#awaitingKeyCheck(state)) {
      return;
    }
    switch (state) {
      case "connected":
        // A fresh connection, or a reconnect that may have missed deltas (or reached a restarted server whose seq
        // began again): drop anything buffered and replace the state with a new snapshot.
        this.#resubscribe(true);
        // The server forgets a connection's watchlist with the connection; tell it again.
        this.#sendWatchlist();
        break;
      case "disconnected":
        if (this.#running) {
          this.#clearTimer();
          this.#cancelTimer = this.#schedule(() => this.#connect(), RESTART_MS);
        }
        break;
      case "connecting":
      case "reconnecting":
        break;
      default: {
        const unreachable: never = state;
        return unreachable;
      }
    }
  }

  #resubscribe(fresh = false): void {
    const selection = this.#selection;
    if (!selection) {
      return;
    }
    if (fresh) {
      // A restarted engine numbers seq from zero. The previous connection's book is not a floor for this one.
      this.#seqFloor = null;
    }
    const keep = !fresh && this.#phase?.kind === "awaiting-snapshot" && this.#phase.root === selection.instrument;
    const buffered = keep && this.#phase?.kind === "awaiting-snapshot" ? this.#phase.buffered : [];
    this.#phase = awaitSnapshot(selection.instrument, buffered);
    this.#update({ awaitingSnapshot: true });
    if (this.#connection.state() !== "connected") {
      return;
    }
    const token = ++this.#token;
    this.#connection.subscribe(selection.instrument, selection.historyMinutes, selection.indicatorMinutes).then(
      (payload) => {
        if (token !== this.#token) {
          return;
        }
        const parsed = snapshotSchema.safeParse(payload);
        if (!parsed.success || !this.#phase) {
          this.#update({ error: "The snapshot did not match the expected shape." });
          this.#retrySubscribe(token);
          return;
        }
        // A snapshot that finished after a newer one on this connection must not rewind it. An equal seq is
        // the timeframe refresh: the server re-sends the current publication with the series just requested.
        if (this.#seqFloor !== null && parsed.data.seq < this.#seqFloor) {
          return;
        }
        const step = receiveSnapshot(this.#phase, parsed.data, selection.historyMinutes, this.#now());
        this.#update({ error: null });
        if (step.resync) {
          // A gap right after a snapshot: back off before asking again rather than spinning on subscribe.
          this.#phase = step.phase;
          this.#update({ resyncs: this.#view.resyncs + 1 });
          this.#scheduleResync();
          return;
        }
        this.#apply(step);
      },
      (error: unknown) => {
        if (token !== this.#token) {
          return;
        }
        this.#update({ error: error instanceof Error ? error.message : "Subscribe failed." });
        this.#retrySubscribe(token);
      },
    );
  }

  #sendWatchlist(): void {
    const roots = this.#watchlist;
    if (!roots || this.#connection.state() !== "connected") {
      return;
    }
    const token = ++this.#watchToken;
    this.#connection.setWatchlist(roots).then(
      (payload) => {
        if (token !== this.#watchToken) {
          return;
        }
        const parsed = watchlistResultSchema.safeParse(payload);
        // An answer we cannot read says nothing about depth: show no star as refused rather than guess.
        this.#update(
          parsed.success
            ? { depthRoots: parsed.data.depth, refusedRoots: parsed.data.refused }
            : { depthRoots: null, refusedRoots: [] },
        );
      },
      () => {
        // A failed call leaves the last answer shown; the next connect or change sends the list again.
      },
    );
  }

  #retrySubscribe(token: number): void {
    this.#clearTimer();
    this.#cancelTimer = this.#schedule(() => {
      if (token === this.#token && this.#running) {
        this.#resubscribe();
      }
    }, RETRY_SUBSCRIBE_MS);
  }

  #onDelta(payload: unknown): void {
    const phase = this.#phase;
    if (!phase) {
      return;
    }
    const parsed = deltaSchema.safeParse(payload);
    if (!parsed.success) {
      // A delta we cannot read is a delta we missed.
      this.#update({ rejectedDeltas: this.#view.rejectedDeltas + 1 });
      if (phase.kind === "live") {
        this.#update({ resyncs: this.#view.resyncs + 1 });
        this.#scheduleResync();
      }
      return;
    }
    const step = receiveDelta(phase, parsed.data, this.#now());
    if (!step.resync) {
      this.#gapResyncs = 0;
    }
    this.#apply(step);
  }

  #apply(step: StreamStep): void {
    this.#phase = step.phase;
    if (step.phase.kind === "live") {
      this.#seqFloor = step.phase.state.seq;
      this.#update({ market: step.phase.state, awaitingSnapshot: false });
    }
    if (step.resync) {
      this.#update({ resyncs: this.#view.resyncs + 1 });
      this.#scheduleResync();
    }
  }

  /** A server-pushed snapshot replaces the book without counting as a gap resubscribe. */
  #onSnapshot(payload: unknown): void {
    const selection = this.#selection;
    const phase = this.#phase;
    if (!selection || !phase) {
      return;
    }
    const parsed = snapshotSchema.safeParse(payload);
    if (!parsed.success || parsed.data.root !== selection.instrument) {
      return;
    }
    const currentSeq = this.#view.market?.root === selection.instrument ? this.#view.market.seq : null;
    // A catch-up built before the timeframe changed can share the subscribe snapshot's seq. Applying it
    // would put the old series back; a later delta would then append only the new points.
    if (currentSeq !== null && parsed.data.seq <= currentSeq) {
      return;
    }
    if (indicatorsForViewer(parsed.data.indicators, selection.indicatorMinutes).length !== parsed.data.indicators.length) {
      return;
    }
    this.#clearTimer();
    const step = receiveSnapshot(
      phase.kind === "awaiting-snapshot" && phase.root === selection.instrument ? phase : awaitSnapshot(selection.instrument),
      parsed.data,
      selection.historyMinutes,
      this.#now(),
    );
    if (!step.resync) {
      this.#gapResyncs = 0;
    }
    this.#apply(step);
  }

  /** Waits longer after each gap so a slow browser does not resubscribe in a loop. */
  #scheduleResync(): void {
    const delay = Math.min(MAX_RESYNC_MS, RETRY_SUBSCRIBE_MS * 2 ** Math.min(this.#gapResyncs, 4));
    this.#gapResyncs += 1;
    this.#clearTimer();
    this.#cancelTimer = this.#schedule(() => {
      if (this.#running) {
        this.#resubscribe();
      }
    }, delay);
  }
}
