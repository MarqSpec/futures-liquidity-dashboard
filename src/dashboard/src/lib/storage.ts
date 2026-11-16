/**
 * Browser storage that never throws: a private window, blocked site data or a full quota just means nothing is
 * remembered. Used only for per-viewer conveniences (the layout's fallback when the API cannot save it).
 */
export function readStored(key: string): unknown {
  try {
    const text = globalThis.localStorage?.getItem(key);
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

/** Stores `value` as JSON under `key`; returns whether it was stored. */
export function writeStored(key: string, value: unknown): boolean {
  try {
    if (!globalThis.localStorage) {
      return false;
    }
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
