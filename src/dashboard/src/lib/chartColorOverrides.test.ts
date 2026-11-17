import { describe, expect, it, vi } from "vitest";

import { CHART_COLORS_STORAGE_KEY, createChartColorStore } from "./chartColorOverrides.ts";

// The viewer's chart colours are kept per theme in this browser only, under one versioned key.

function memoryStorage(initial: Record<string, string> = {}): Storage & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

function blockedStorage(): Storage {
  const refuse = () => {
    throw new Error("SecurityError");
  };
  return { length: 0, clear: refuse, getItem: refuse, key: refuse, removeItem: refuse, setItem: refuse };
}

describe("createChartColorStore", () => {
  it("should keep the overrides under one versioned key", () => {
    expect(CHART_COLORS_STORAGE_KEY).toBe("futures-liquidity-dashboard.chart-colors.v1");
  });

  it("should read the stored overrides of each theme when it starts", () => {
    const storage = memoryStorage({ [CHART_COLORS_STORAGE_KEY]: JSON.stringify({ dark: { up: "#112233" }, light: { bid: "#445566" } }) });

    const store = createChartColorStore({ storage: () => storage });

    expect(store.overrides()).toEqual({ dark: { up: "#112233" }, light: { bid: "#445566" } });
  });

  it("should drop an unknown role and a value that is not a colour when it reads them", () => {
    const storage = memoryStorage({ [CHART_COLORS_STORAGE_KEY]: JSON.stringify({ dark: { up: "#112233", nope: "#112233", down: "blue" } }) });

    expect(createChartColorStore({ storage: () => storage }).overrides()).toEqual({ dark: { up: "#112233" }, light: {} });
  });

  it.each([
    ["nothing is stored", memoryStorage()],
    ["the stored text is not JSON", memoryStorage({ [CHART_COLORS_STORAGE_KEY]: "{not json" })],
    ["the store throws", blockedStorage()],
  ])("should use the theme defaults when %s", (_case, storage) => {
    expect(createChartColorStore({ storage: () => storage }).overrides()).toEqual({ dark: {}, light: {} });
  });

  it("should ignore an older key's value, so a new format starts from the theme", () => {
    const storage = memoryStorage({ "futures-liquidity-dashboard.chart-colors": JSON.stringify({ dark: { up: "#112233" } }) });

    expect(createChartColorStore({ storage: () => storage }).overrides()).toEqual({ dark: {}, light: {} });
  });

  it("should apply, store and announce a colour once when a role is set", () => {
    const storage = memoryStorage();
    const store = createChartColorStore({ storage: () => storage });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set("light", "up", "#ABCDEF");

    expect(store.overrides()).toEqual({ dark: {}, light: { up: "#abcdef" } });
    expect(JSON.parse(storage.data.get(CHART_COLORS_STORAGE_KEY) ?? "null")).toEqual({ dark: {}, light: { up: "#abcdef" } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unknown role", "nope", "#123456"],
    ["a token that is not configurable", "surface", "#123456"],
    ["a value that is not a colour", "up", "red"],
  ])("should change and announce nothing when it is given %s", (_case, token, colour) => {
    const storage = memoryStorage();
    const store = createChartColorStore({ storage: () => storage });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set("dark", token, colour);

    expect(store.overrides()).toEqual({ dark: {}, light: {} });
    expect(storage.data.has(CHART_COLORS_STORAGE_KEY)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("should not announce a colour the role already has", () => {
    const store = createChartColorStore({ storage: () => memoryStorage() });
    store.set("dark", "up", "#123456");
    const listener = vi.fn();
    store.subscribe(listener);

    store.set("dark", "up", "#123456");

    expect(listener).not.toHaveBeenCalled();
  });

  it("should return one role of one theme to its default when it is reset", () => {
    const storage = memoryStorage();
    const store = createChartColorStore({ storage: () => storage });
    store.set("dark", "up", "#123456");
    store.set("dark", "down", "#654321");
    store.set("light", "up", "#abcdef");

    store.reset("dark", "up");

    expect(store.overrides()).toEqual({ dark: { down: "#654321" }, light: { up: "#abcdef" } });
  });

  it("should return every role of one theme to its default, and leave the other theme, when all are reset", () => {
    const storage = memoryStorage();
    const store = createChartColorStore({ storage: () => storage });
    store.set("dark", "up", "#123456");
    store.set("light", "up", "#abcdef");

    store.resetAll("dark");

    expect(store.overrides()).toEqual({ dark: {}, light: { up: "#abcdef" } });
  });

  it("should remove the key when nothing is left overridden, so the browser holds no stale value", () => {
    const storage = memoryStorage();
    const store = createChartColorStore({ storage: () => storage });
    store.set("dark", "up", "#123456");

    store.reset("dark", "up");

    expect(storage.data.has(CHART_COLORS_STORAGE_KEY)).toBe(false);
  });

  it("should still apply a colour when the store refuses to keep it", () => {
    const store = createChartColorStore({ storage: () => blockedStorage() });

    store.set("dark", "up", "#123456");

    expect(store.overrides().dark).toEqual({ up: "#123456" });
  });

  it("should read the key again and announce it when another window changes or clears it", () => {
    const storage = memoryStorage();
    let changed: (() => void) | undefined;
    const store = createChartColorStore({
      storage: () => storage,
      watch: (onChange) => {
        changed = onChange;
        return () => undefined;
      },
    });
    store.set("dark", "up", "#123456");
    const listener = vi.fn();
    store.subscribe(listener);

    storage.clear();
    changed?.();

    expect(store.overrides()).toEqual({ dark: {}, light: {} });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
