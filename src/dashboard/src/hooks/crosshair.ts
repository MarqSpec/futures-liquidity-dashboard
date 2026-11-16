/** Where the pointer is over the time-aligned panes. */
export interface Crosshair {
  readonly timeMs: number | null;
  /** Set only over the main chart, the one pane with a price axis in ticks. */
  readonly priceTicks: number | null;
}

/** A tiny external store, so pointer moves redraw only the crosshair layers and never re-render React. */
export interface CrosshairStore {
  get(): Crosshair;
  set(next: Crosshair): void;
  subscribe(listener: () => void): () => void;
}

/** Creates an empty crosshair store. */
export function createCrosshairStore(): CrosshairStore {
  let value: Crosshair = { timeMs: null, priceTicks: null };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (next.timeMs === value.timeMs && next.priceTicks === value.priceTicks) {
        return;
      }
      value = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
