// A waiting worker must not reload a tab that is showing the book. Only the tab that accepts does.

export interface ServiceWorkerOffer {
  readonly available: boolean;
  readonly apply: () => void;
  readonly dismiss: () => void;
}

let available = false;
let applyUpdate: (() => void) | null = null;
let accepted = false;
const listeners = new Set<() => void>();

const applyAccepted = (): void => {
  if (!applyUpdate) {
    return;
  }
  accepted = true;
  const run = applyUpdate;
  applyUpdate = null;
  available = false;
  publish();
  run();
};

const dismissOffer = (): void => {
  available = false;
  publish();
};

let snapshot: ServiceWorkerOffer = { available: false, apply: applyAccepted, dismiss: dismissOffer };

function publish(): void {
  snapshot = { available, apply: applyAccepted, dismiss: dismissOffer };
  for (const listener of listeners) {
    listener();
  }
}

/** The banner's current offer. The same object until the offer changes. */
export function serviceWorkerOffer(): ServiceWorkerOffer {
  return snapshot;
}

/** Registers a change listener; returns the unsubscribe function. */
export function subscribeServiceWorkerOffer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A new worker is waiting. `apply` is what reloads this tab, and nothing calls it until the viewer asks. */
export function offerServiceWorkerUpdate(apply: () => void): void {
  applyUpdate = apply;
  available = true;
  publish();
}

/** True only after this tab accepted the waiting worker. Another open tab stays false. */
export function shouldReloadForServiceWorkerUpdate(): boolean {
  return accepted;
}

/** Drops the offer. Tests start from an empty banner. */
export function resetServiceWorkerOffer(): void {
  available = false;
  applyUpdate = null;
  accepted = false;
  publish();
}
