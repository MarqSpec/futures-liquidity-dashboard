/** Whether the page is shown, and a way to hear when that changes. */
export interface Visibility {
  hidden(): boolean;
  /** Registers a listener; returns the function that removes it. */
  onChange(listener: () => void): () => void;
}

/** The browser's page visibility (`document.hidden`); always visible where there is no document. */
export function documentVisibility(): Visibility {
  const doc = globalThis.document as Document | undefined;
  return {
    hidden: () => doc?.hidden ?? false,
    onChange(listener) {
      doc?.addEventListener("visibilitychange", listener);
      return () => doc?.removeEventListener("visibilitychange", listener);
    },
  };
}

/** What `poll` needs besides the read itself; the clock and visibility are injectable for tests. */
export interface PollOptions {
  readonly intervalMs: number;
  readonly visibility: Visibility;
  readonly schedule?: (callback: () => void, ms: number) => () => void;
}

const defaultSchedule = (callback: () => void, ms: number) => {
  const id = setTimeout(callback, ms);
  return () => clearTimeout(id);
};

/**
 * Calls `load` every `intervalMs` while the page is visible and hands each answer to `onData`; a failed read is
 * skipped and the next one tried on schedule. The first read waits one interval (the caller already holds data).
 * A hidden page is not polled; showing it again reads at once, since what is held is stale by then. One read is
 * in flight at most. Returns the function that stops polling and aborts a read in flight.
 */
export function poll<T>(load: (signal: AbortSignal) => Promise<T>, onData: (value: T) => void, options: PollOptions): () => void {
  const { intervalMs, visibility } = options;
  const schedule = options.schedule ?? defaultSchedule;
  const controller = new AbortController();
  let cancelTimer: (() => void) | null = null;
  let inFlight = false;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const next = () => {
    clearTimer();
    if (!controller.signal.aborted && !visibility.hidden()) {
      cancelTimer = schedule(tick, intervalMs);
    }
  };

  function tick(): void {
    cancelTimer = null;
    if (controller.signal.aborted || visibility.hidden() || inFlight) {
      return;
    }
    inFlight = true;
    load(controller.signal).then(
      (value) => {
        inFlight = false;
        if (!controller.signal.aborted) {
          onData(value);
          next();
        }
      },
      () => {
        inFlight = false;
        next();
      },
    );
  }

  const removeListener = visibility.onChange(() => {
    if (visibility.hidden()) {
      clearTimer();
    } else if (!inFlight) {
      clearTimer();
      tick();
    }
  });
  next();

  return () => {
    controller.abort();
    clearTimer();
    removeListener();
  };
}
