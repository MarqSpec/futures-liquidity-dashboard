import { useEffect, useState } from "react";

import { getInstruments } from "../api/client.ts";
import type { InstrumentSummary } from "../api/schemas.ts";
import { retainUnchangedSummaries } from "../domain/instrumentRows.ts";
import { documentVisibility, poll } from "../lib/poll.ts";

const POLL_MS = 2000;

/**
 * Every product the viewer may see, with its status and session summary: seeded from the route loader's answer,
 * then re-read from GET /api/instruments every 2 s while the page is visible. The returned array changes only when
 * an answer differs from the one held, so the picker re-renders only then.
 */
export function useInstrumentSummaries(seed: readonly InstrumentSummary[]): readonly InstrumentSummary[] {
  const [held, setHeld] = useState<{ readonly key: string; readonly rows: readonly InstrumentSummary[] }>(() => ({
    key: JSON.stringify(seed),
    rows: seed,
  }));

  useEffect(
    () =>
      poll(
        getInstruments,
        (rows) => {
          const key = JSON.stringify(rows);
          setHeld((current) => (current.key === key ? current : { key, rows: retainUnchangedSummaries(current.rows, rows) }));
        },
        { intervalMs: POLL_MS, visibility: documentVisibility() },
      ),
    [],
  );

  return held.rows;
}
