/**
 * The viewer API key for this tab (ARCHITECTURE.md D-30). sessionStorage keeps it across a reload and drops it
 * when the tab closes. localStorage would keep it after the operator leaves a shared browser, so it is not used.
 * A private window that blocks site data keeps the key in memory for this page only. The key is never read from
 * a VITE_* variable: those are copied into the bundle.
 */
const STORAGE_KEY = "futures-liquidity-dashboard.apiKey";

type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const memory = new Map<string, string>();
const memoryStorage: KeyStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
  },
  removeItem: (key) => {
    memory.delete(key);
  },
};

let replacement: KeyStorage | null = null;
let resolved: KeyStorage | null = null;
const unauthorizedListeners = new Set<() => void>();

function browserSession(): KeyStorage | null {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return null;
    }
    const probe = `${STORAGE_KEY}.probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function storage(): KeyStorage {
  if (replacement) {
    return replacement;
  }
  if (!resolved) {
    resolved = browserSession() ?? memoryStorage;
  }
  return resolved;
}

/** Tests substitute the store. Pass null to use sessionStorage or memory again. */
export function useApiKeyStorage(next: KeyStorage | null): void {
  replacement = next;
  if (next) {
    next.removeItem(STORAGE_KEY);
  }
}

/** The key for this tab, or null when the viewer has not entered one. */
export function readApiKey(): string | null {
  const value = storage().getItem(STORAGE_KEY);
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Remembers `key` for this tab. A blank key is cleared instead. */
export function setApiKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    clearApiKey();
    return;
  }
  storage().setItem(STORAGE_KEY, trimmed);
}

/** Forgets the key for this tab. */
export function clearApiKey(): void {
  storage().removeItem(STORAGE_KEY);
}

/** Hears that a call was rejected with 401. Returns the unsubscribe function. */
export function subscribeUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/** Tells the key prompt that the stored key was rejected. A probe that handles 401 itself does not call this. */
export function reportUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    listener();
  }
}
