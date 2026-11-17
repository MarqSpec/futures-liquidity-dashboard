import {
  CHART_COLOR_ROLES,
  isChartColor,
  NO_OVERRIDES,
  parseChartColorOverrides,
  type ChartColorOverrides,
} from "../design/chartColors.ts";
import type { ThemeId } from "../design/tokenFile.ts";

// The viewer's chart colours: per theme, kept in this browser only under one versioned localStorage key, never in the
// saved layout or on the server. Read inside try/catch, so a blocked store means the theme's own colours.

/** The one key the overrides are stored under; a new format takes a new version, so an old value is never misread. */
export const CHART_COLORS_STORAGE_KEY = "futures-liquidity-dashboard.chart-colors.v1";

const ROLE_TOKENS = new Set(CHART_COLOR_ROLES.map((role) => role.token));

/** Where the store reads and writes: `storage` may be missing or throw; `watch` reports a change made elsewhere. */
export interface ChartColorStoreEnvironment {
  readonly storage: () => Storage | undefined;
  /** Calls `onChange` when another window changes or clears the key; returns the unsubscribe. */
  readonly watch?: (onChange: () => void) => () => void;
}

/** The overrides as an external store for `useSyncExternalStore`. */
export interface ChartColorStore {
  /** Both themes' overrides; a new object after every change. */
  readonly overrides: () => ChartColorOverrides;
  readonly subscribe: (listener: () => void) => () => void;
  /** Sets `token` to `colour` in `theme`; an unknown role or a value that is not a colour changes nothing. */
  readonly set: (theme: ThemeId, token: string, colour: string) => void;
  /** Returns `token` in `theme` to its theme default. */
  readonly reset: (theme: ThemeId, token: string) => void;
  /** Returns every role in `theme` to its theme default. */
  readonly resetAll: (theme: ThemeId) => void;
}

function read(storage: () => Storage | undefined): ChartColorOverrides {
  try {
    const text = storage()?.getItem(CHART_COLORS_STORAGE_KEY);
    return text ? parseChartColorOverrides(JSON.parse(text)) : NO_OVERRIDES;
  } catch {
    return NO_OVERRIDES;
  }
}

function write(storage: () => Storage | undefined, overrides: ChartColorOverrides): void {
  try {
    const store = storage();
    if (Object.keys(overrides.dark).length === 0 && Object.keys(overrides.light).length === 0) {
      store?.removeItem(CHART_COLORS_STORAGE_KEY);
    } else {
      store?.setItem(CHART_COLORS_STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // A blocked or full store only means the colours are not remembered; they still apply now.
  }
}

/** The chart-colour overrides over `environment`. */
export function createChartColorStore(environment: ChartColorStoreEnvironment): ChartColorStore {
  let state: ChartColorOverrides | undefined;
  const listeners = new Set<() => void>();

  const announce = () => {
    for (const listener of [...listeners]) listener();
  };

  const current = (): ChartColorOverrides => {
    if (state === undefined) {
      state = read(environment.storage);
      environment.watch?.(() => {
        state = read(environment.storage);
        announce();
      });
    }
    return state;
  };

  const replace = (theme: ThemeId, next: Readonly<Record<string, string>>) => {
    state = { ...current(), [theme]: next };
    write(environment.storage, state);
    announce();
  };

  return {
    overrides: current,
    subscribe: (listener) => {
      current();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (theme, token, colour) => {
      if (!ROLE_TOKENS.has(token) || !isChartColor(colour)) return;
      const value = colour.toLowerCase();
      const themeOverrides = current()[theme];
      if (themeOverrides[token] === value) return;
      replace(theme, { ...themeOverrides, [token]: value });
    },
    reset: (theme, token) => {
      const themeOverrides = current()[theme];
      if (!Object.hasOwn(themeOverrides, token)) return;
      const { [token]: _dropped, ...rest } = themeOverrides;
      replace(theme, rest);
    },
    resetAll: (theme) => {
      if (Object.keys(current()[theme]).length === 0) return;
      replace(theme, {});
    },
  };
}

/** The app's chart colours: this browser's localStorage, followed across its windows. */
export const chartColorStore: ChartColorStore = createChartColorStore({
  storage: () => globalThis.localStorage,
  watch: (onChange) => {
    if (typeof globalThis.addEventListener !== "function") return () => undefined;
    const listener = (event: StorageEvent) => {
      if (event.key === null || event.key === CHART_COLORS_STORAGE_KEY) onChange();
    };
    globalThis.addEventListener("storage", listener);
    return () => globalThis.removeEventListener("storage", listener);
  },
});
