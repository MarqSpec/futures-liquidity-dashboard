import { useEffect, useState } from "react";

import { activePerfProbe, browserPerfHost, percentile, startPerfProbe } from "../lib/perfProbe.ts";

const REFRESH_MS = 1000;

interface Reading {
  readonly frameP50: number | null;
  readonly frameP95: number | null;
  readonly drawP95: number | null;
}

const empty: Reading = { frameP50: null, frameP95: null, drawP95: null };

function ms(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

/**
 * The `?perf=1` overlay: starts the probe while mounted and shows p50/p95 frame time and p95 main-chart draw time,
 * refreshed once a second. Rendered only when the flag is present, so without it nothing here runs.
 */
export function PerfOverlay() {
  const [reading, setReading] = useState<Reading>(empty);

  useEffect(() => {
    const stop = startPerfProbe(browserPerfHost());
    const id = setInterval(() => {
      const probe = activePerfProbe();
      if (!probe) return;
      setReading({
        frameP50: percentile(probe.frames, 50),
        frameP95: percentile(probe.frames, 95),
        drawP95: percentile(probe.draws, 95),
      });
    }, REFRESH_MS);
    return () => {
      clearInterval(id);
      stop();
    };
  }, []);

  return (
    <output className="perf-overlay" aria-label="Frame and draw times">
      frame p50 {ms(reading.frameP50)} / p95 {ms(reading.frameP95)} ms · draw p95 {ms(reading.drawP95)} ms
    </output>
  );
}
