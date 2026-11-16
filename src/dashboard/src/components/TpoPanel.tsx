import type { Tpo } from "../api/schemas.ts";
import { formatLocalMinute, formatTicks, type TickSpec } from "../domain/format.ts";

/** Props of the TPO panel. */
export interface TpoPanelProps {
  readonly tpo: Tpo;
  readonly spec: TickSpec;
  readonly showSinglePrints: boolean;
}

/** The session's market profile: one row per price bucket with its period letters, single prints and POC marked. */
export function TpoPanel({ tpo, spec, showSinglePrints }: TpoPanelProps) {
  const rows = [...tpo.rows].sort((a, b) => b.priceTicks - a.priceTicks);
  const inSingle = (p: number) => showSinglePrints && tpo.singlePrints.some((run) => p >= run.lowTicks && p <= run.highTicks);
  return (
    <section className="panel tpo" aria-label="TPO profile">
      <h2>
        TPO{" "}
        <span className="muted">
          {tpo.periodMinutes} min · {tpo.rowTicks} ticks/row
          {tpo.partialSinceMs != null && ` · partial since ${formatLocalMinute(tpo.partialSinceMs)}`}
        </span>
      </h2>
      {rows.length === 0 ? (
        <p className="muted">No TPO rows yet.</p>
      ) : (
        <ol className="scroll tpo-rows">
          {rows.map((row) => (
            <li
              key={row.priceTicks}
              className={[row.priceTicks === tpo.pocTicks ? "poc" : "", inSingle(row.priceTicks) ? "single" : ""].join(" ").trim() || undefined}
            >
              <span className="tpo-price">{formatTicks(row.priceTicks, spec)}</span>
              <span className="tpo-letters">{row.letters}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
