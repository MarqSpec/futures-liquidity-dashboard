import { useMemo, useState } from "react";

import { signalKinds, type Signal } from "../api/schemas.ts";
import { reuseRows, signalRows, SIGNAL_LIST_LIMIT, type IcebergFloors, type SignalRow } from "../domain/signalClusters.ts";


const knownKinds: ReadonlySet<string> = new Set(signalKinds);
const none: readonly SignalRow[] = [];

/**
 * The Signals panel's rows (`signalRows`), memoised on the signals, the kind toggles and the floors by value, so a pan
 * or zoom render with fresh closures does not re-cluster the history, and a row whose signals did not change is the
 * same object as before. `isKindOn` is asked only for the kinds a layout
 * can toggle; a kind the server added later is always listed. Null signals give no rows and compute nothing.
 */
export function useSignalRows(
  signals: readonly Signal[] | null,
  isKindOn: (kind: string) => boolean,
  floors: IcebergFloors,
  limit = SIGNAL_LIST_LIMIT,
): readonly SignalRow[] {
  const kindsOn = signalKinds.filter((kind) => isKindOn(kind)).join(",");
  const { minStrengthPercent, minHiddenSize } = floors;
  const computed = useMemo(() => {
    if (!signals) return none;
    const on = new Set(kindsOn.split(","));
    return signalRows(signals, (kind) => on.has(kind) || !knownKinds.has(kind), { minStrengthPercent, minHiddenSize }, limit);
  }, [signals, kindsOn, minStrengthPercent, minHiddenSize, limit]);
  // A row whose signals did not change keeps its object, so its memoised view is not re-rendered.
  const [shown, setShown] = useState({ computed, rows: computed });
  if (shown.computed !== computed) setShown({ computed, rows: reuseRows(shown.rows, computed) });
  return shown.computed === computed ? shown.rows : computed;
}
