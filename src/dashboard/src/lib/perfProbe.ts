/**
 * A measuring aid, on only when the page's URL has `?perf=1`: frame times from a requestAnimationFrame loop and the
 * main chart's draw times, kept for the last ~600 of each and exposed as `window.__dashPerf` for a console or a
 * test harness to read. Without the flag nothing runs: no loop, no overlay, and `timeDraw` only calls through.
 */

/** What the probe exposes on `window.__dashPerf`. */
export interface DashPerf {
  /** Milliseconds between consecutive animation frames, oldest first. */
  readonly frames: number[];
  /** Milliseconds each main-chart draw took, oldest first. */
  readonly draws: number[];
  /** Forgets every sample. */
  reset(): void;
}

declare global {
  interface Window {
    __dashPerf?: DashPerf;
  }
}

/** The browser calls the probe uses; injectable for tests. */
export interface PerfHost {
  requestAnimationFrame(callback: (timeMs: number) => void): number;
  cancelAnimationFrame(id: number): void;
  now(): number;
  /** Where `__dashPerf` is published: the window. */
  readonly target: { __dashPerf?: DashPerf };
}

/** How many samples of each kind are kept. */
export const perfSampleLimit = 600;

let active: DashPerf | null = null;
let clock: () => number = () => performance.now();

/** Whether the probe was asked for: `perf=1` in the URL's query string. */
export function perfRequested(search: string): boolean {
  return new URLSearchParams(search).get("perf") === "1";
}

/** The running probe, or null when it is off. */
export function activePerfProbe(): DashPerf | null {
  return active;
}

function push(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > perfSampleLimit) {
    samples.splice(0, samples.length - perfSampleLimit);
  }
}

/** The browser's own calls, published on `window`. */
export function browserPerfHost(): PerfHost {
  return {
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
    now: () => performance.now(),
    target: window,
  };
}

/** Starts the frame loop and publishes `__dashPerf`; returns the function that stops both. */
export function startPerfProbe(host: PerfHost): () => void {
  const probe: DashPerf = {
    frames: [],
    draws: [],
    reset() {
      probe.frames.length = 0;
      probe.draws.length = 0;
    },
  };
  let previous: number | null = null;
  let id = 0;
  const frame = (timeMs: number) => {
    if (previous !== null) push(probe.frames, timeMs - previous);
    previous = timeMs;
    id = host.requestAnimationFrame(frame);
  };
  id = host.requestAnimationFrame(frame);
  active = probe;
  clock = host.now;
  host.target.__dashPerf = probe;
  return () => {
    host.cancelAnimationFrame(id);
    if (active === probe) active = null;
    if (host.target.__dashPerf === probe) delete host.target.__dashPerf;
  };
}

/** Runs `draw`, timing it when the probe is on; otherwise just calls it. */
export function timeDraw<T>(draw: () => T): T {
  const probe = active;
  if (!probe) return draw();
  const start = clock();
  const result = draw();
  push(probe.draws, clock() - start);
  return result;
}

/** The `p`-th percentile (0–100) of `values` by nearest rank; null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}
