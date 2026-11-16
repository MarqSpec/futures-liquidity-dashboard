import type { Bias, Signal } from "../api/schemas.ts";
import { color } from "../design/tokens.ts";
import { canvasColors, themed } from "../theme.ts";

/** Colours by bias, in the active canvas theme: what a signal implies for price, never who was aggressive. */
export const biasColors: Readonly<Record<Bias, string>> = themed((theme) => {
  const colors = canvasColors(theme);
  return { Bullish: colors.biasBullish, Bearish: colors.biasBearish, Neutral: colors.biasNeutral };
});

/** Human names for the signal kinds. */
export const signalKindNames: Readonly<Record<string, string>> = {
  Iceberg: "Iceberg (inferred)",
  StackedImbalance: "Stacked imbalance",
  UnfinishedAuction: "Unfinished auction",
  TrappedTraders: "Trapped traders",
  CvdDivergence: "CVD divergence",
  DeltaExhaustion: "Delta exhaustion",
  Spoof: "Spoof",
  LiquiditySweep: "Liquidity sweep (inferred)",
  SinglePrints: "Single prints",
};

/** The display name of a kind, falling back to the raw kind for one the server added later. */
export function kindName(kind: string): string {
  return signalKindNames[kind] ?? kind;
}

/**
 * One color per event, from a palette that stays distinct for the common color-blindnesses: each kind's own
 * `event-*` token. An inferred reading is drawn hollow; the others are filled (REQUIREMENTS.md FR-62, FR-67).
 */
const eventKinds = [
  { kind: "Iceberg", name: "Iceberg", token: "event-iceberg", inferred: true },
  { kind: "StackedImbalance", name: "Stacked imbalance", token: "event-stacked-imbalance", inferred: false },
  { kind: "UnfinishedAuction", name: "Unfinished auction", token: "event-unfinished-auction", inferred: false },
  { kind: "TrappedTraders", name: "Trapped traders", token: "event-trapped-traders", inferred: true },
  { kind: "CvdDivergence", name: "CVD divergence", token: "event-cvd-divergence", inferred: false },
  { kind: "DeltaExhaustion", name: "Delta exhaustion", token: "event-delta-exhaustion", inferred: false },
  { kind: "Spoof", name: "Spoof", token: "event-spoof", inferred: true },
  { kind: "LiquiditySweep", name: "Liquidity sweep", token: "event-liquidity-sweep", inferred: true },
  { kind: "SinglePrints", name: "Single prints", token: "event-single-prints", inferred: false },
  { kind: "FailedReclaim", name: "Failed reclaim", token: "event-failed-reclaim", inferred: true },
] as const;

export interface EventMarker {
  readonly kind: string;
  readonly name: string;
  /** The colour token, for a DOM swatch: `var(--${token})`. */
  readonly token: string;
  readonly color: string;
  readonly inferred: boolean;
}

/** Each kind's colour and the unknown kind's, in the active canvas theme. */
const eventColors: Readonly<Record<string, string>> = themed((theme) =>
  Object.fromEntries([...eventKinds.map((marker) => marker.token), "event-unknown"].map((token) => [token, color(token, theme)])),
);

function withThemeColour(marker: Omit<EventMarker, "color">): EventMarker {
  return {
    ...marker,
    get color() {
      return eventColors[marker.token] ?? eventColors["event-unknown"] ?? "";
    },
  };
}

/** The marker of every known kind, in the order the key lists them; `color` is the active theme's. */
export const eventMarkers: readonly EventMarker[] = eventKinds.map(withThemeColour);

/** The color and hollow/filled style for an event kind. An unknown kind is a neutral filled dot. */
export function eventMarker(kind: string): EventMarker {
  const known = eventMarkers.find((marker) => marker.kind === kind);
  if (known) return known;
  const name = kindName(kind);
  return withThemeColour({ kind, name, token: "event-unknown", inferred: name.toLowerCase().includes("inferred") });
}

/**
 * Every signal of an enabled kind inside `[startMs, endMs]`, in the order held. None are dropped for a paint cap,
 * so panning back shows an event that is still loaded (REQUIREMENTS.md FR-69).
 */
export function eventsInWindow<T extends { readonly timeMs: number; readonly kind: string }>(
  signals: readonly T[],
  isOn: (kind: string) => boolean,
  startMs: number,
  endMs: number,
): T[] {
  const shown: T[] = [];
  for (const signal of signals) {
    if (signal.timeMs < startMs || signal.timeMs > endMs) continue;
    if (!isOn(signal.kind)) continue;
    shown.push(signal);
  }
  return shown;
}

/** The signals whose kind `isOn` accepts, newest first, at most `limit`. */
export function visibleSignals(
  signals: readonly Signal[],
  isOn: (kind: string) => boolean,
  limit = Number.POSITIVE_INFINITY,
): Signal[] {
  const result: Signal[] = [];
  for (let i = signals.length - 1; i >= 0 && result.length < limit; i--) {
    const signal = signals[i];
    if (signal && isOn(signal.kind)) {
      result.push(signal);
    }
  }
  return result;
}

/** How many signals of each kind there are. */
export function countByKind(signals: readonly Signal[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const signal of signals) {
    counts.set(signal.kind, (counts.get(signal.kind) ?? 0) + 1);
  }
  return counts;
}

/** Signals of `kind` at or after `sinceMs`, for markers that only matter while recent (a spoof on the ladder). */
export function recentOfKind(signals: readonly Signal[], kind: string, sinceMs: number): Signal[] {
  return signals.filter((s) => s.kind === kind && s.timeMs >= sinceMs);
}
