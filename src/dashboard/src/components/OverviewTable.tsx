import { memo, useMemo, useState } from "react";

import type { Bias, InstrumentSummary, Regime } from "../api/schemas.ts";
import { watchlistLimit } from "../domain/layout.ts";
import { formatQty, formatTicks } from "../domain/format.ts";
import {
  formatArrowed,
  formatHighLow,
  formatRate,
  formatSignalAge,
  nextSort,
  overviewRow,
  sortedOverview,
  type OverviewRow,
  type OverviewSort,
  type OverviewSortKey,
} from "../domain/overview.ts";
import { formatPercentChange, formatPriceChange, formatSpread, changeTicks, groupSummaries } from "../domain/products.ts";
import { regimeLabel, regimeTitle, regimeTone } from "../domain/regime.ts";
import { kindName } from "../domain/signals.ts";
import { formatChicagoMinute } from "../domain/format.ts";
import { chipTone } from "../domain/status.ts";
import { useNow } from "../hooks/useNow.ts";
import { ChangeServerButton } from "./ChangeServerButton.tsx";
import { Star } from "./ProductPanel.tsx";

/** Props of the Overview. */
export interface OverviewTableProps {
  readonly summaries: readonly InstrumentSummary[];
  readonly watchlist: readonly string[];
  /** The product the Detail tab shows. */
  readonly active: string;
  /** Opens the Detail tab on `root`. */
  readonly onOpen: (root: string) => void;
  /** Watched roots the server would not pull depth for. */
  readonly refused: readonly string[];
  /** Adds a root to the watchlist or takes it off. */
  readonly onWatch: (root: string, on: boolean) => void;
}

const columns: readonly (readonly [OverviewSortKey, string, string])[] = [
  ["product", "Product", "Root and name"],
  ["last", "Last", "Last traded price"],
  ["change", "Chg", "Change from the session open, and as a percentage of it"],
  ["range", "High / Low", "Session high and low; sorts by range as a share of the open"],
  ["volume", "Vol", "Session volume"],
  ["spread", "Spr", "Spread in ticks (ask minus bid)"],
  ["tradeRate", "Rate", "Contracts traded per second, last 10 s"],
  ["delta60s", "Δ60s", "Volume delta over the last 60 seconds"],
  ["cvd", "CVD", "Session cumulative volume delta"],
  ["regime5m", "5m", "Regime on 5-minute bars"],
  ["regime15m", "15m", "Regime on 15-minute bars"],
  ["agreement", "5m/15m", "Whether the 5- and 15-minute regimes agree"],
  ["signal", "Signal", "Newest order-flow signal, its age, and signals in the last 15 minutes"],
  ["health", "Feed", "Feed status, and whether the server holds the product's depth"],
];

/** A signal's kind takes its bias token as a CSS variable, so the row follows the theme without a re-render. */
const biasVariables: Readonly<Record<Bias, string>> = {
  Bullish: "var(--bias-bullish)",
  Bearish: "var(--bias-bearish)",
  Neutral: "var(--bias-neutral)",
};

const agreementText = { agree: "Agree", conflict: "Conflict", mixed: "Mixed" } as const;
const agreementTitle = {
  agree: "Both timeframes trend the same way, or both range",
  conflict: "The timeframes trend opposite ways, or one trends while the other ranges",
  mixed: "One timeframe is unclear or still warming up",
} as const;

/** A numeric cell's class, coloured by the sign of `value`. */
function numClass(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value === 0) return "num";
  return value > 0 ? "num dir-up" : "num dir-down";
}

/** A change's direction glyph, so the sign does not rest on colour alone; empty when flat or unknown. */
function changeGlyph(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value === 0) return "";
  return value > 0 ? "▲ " : "▼ ";
}

/** How many products are in each feed status, the known states first and any other after, only those present. */
function statusCounts(summaries: readonly InstrumentSummary[]): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const s of summaries) counts.set(s.status.code, (counts.get(s.status.code) ?? 0) + 1);
  const rank = (code: string) => {
    const known = statusOrder.indexOf(code);
    return known === -1 ? statusOrder.length : known;
  };
  return [...counts].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

const statusOrder: readonly string[] = ["LIVE", "REPLAY", "SIMULATED", "DEGRADED"];

interface OverviewDataRowProps {
  readonly row: OverviewRow;
  readonly active: boolean;
  readonly now: number;
  readonly watched: boolean;
  readonly refused: boolean;
  readonly full: boolean;
  readonly onOpen: (root: string) => void;
  readonly onWatch: (root: string, on: boolean) => void;
}

/** One product. Unchanged products keep their previous render when a poll touches someone else. */
const OverviewDataRow = memo(function OverviewDataRow({ row, active, now, watched, refused, full, onOpen, onWatch }: OverviewDataRowProps) {
  const { instrument, source } = row;
  const s = source.summary;
  const change = changeTicks(s);
  const signal = row.latestSignal;
  return (
    <tr className={active ? "active" : undefined} aria-current={active ? "true" : undefined}>
      <td className="star-cell">
        <Star root={instrument.root} watched={watched} refused={refused} full={full} onWatch={onWatch} />
      </td>
      <td className="product">
        <button
          type="button"
          className="select"
          aria-label={`Open ${instrument.root} in Detail, ${instrument.name}`}
          title={instrument.name}
          onClick={() => onOpen(instrument.root)}
        >
          <strong className="root">{instrument.root}</strong> <span className="name">{instrument.name}</span>
        </button>
      </td>
      <td className="num">{formatTicks(s.last, instrument)}</td>
      <td className={numClass(change)}>
        {changeGlyph(change)}
        {formatPriceChange(change, instrument)} <span className="small-text">{formatPercentChange(change, s.sessionOpen)}</span>
      </td>
      <td className="num">{formatHighLow(s, instrument)}</td>
      <td className="num">{formatQty(s.sessionVolume)}</td>
      <td className="num">{formatSpread(s)}</td>
      <td className="num">{formatRate(s.tradeRate)}</td>
      <td className={numClass(s.delta60s)}>{formatArrowed(s.delta60s)}</td>
      <td className={source.status.cvdKnown ? numClass(s.cumulativeDelta) : "num"}>
        {source.status.cvdKnown ? formatArrowed(s.cumulativeDelta) : "unknown"}
      </td>
      <RegimeCell regime={row.regime5m} row={row} />
      <RegimeCell regime={row.regime15m} row={row} />
      <td className={`agreement agreement-${row.agreement}`} title={agreementTitle[row.agreement]}>
        {agreementText[row.agreement]}
      </td>
      <td className="signal-cell" title={signal ? `${signal.label}: ${signal.detail}` : undefined}>
        {signal ? (
          <>
            <span style={{ color: biasVariables[signal.bias] }}>{kindName(signal.kind)}</span>{" "}
            <span className="muted">{formatSignalAge(Math.max(0, now - signal.timeMs))}</span>
          </>
        ) : (
          <span className="muted">—</span>
        )}{" "}
        <span className="muted" title="Signals in the last 15 minutes">{`· ${s.signals15m}/15m`}</span>
      </td>
      <td>
        <span className={`chip chip-small chip-${chipTone(source.status.code)}`}>{source.status.code}</span>{" "}
        {source.status.missingSinceMs != null && (
          <output className="chip chip-small chip-degraded">
            data missing since {formatChicagoMinute(source.status.missingSinceMs)} CT
          </output>
        )}{" "}
        {source.status.depthSubscribed ? (
          <span className="dom-mark" title="The server holds this product's depth">
            DOM
          </span>
        ) : (
          <span className="muted small-text" title="Trades and quotes only: no depth">
            no DOM
          </span>
        )}
      </td>
    </tr>
  );
}, rowsEqual);

function rowsEqual(prev: OverviewDataRowProps, next: OverviewDataRowProps): boolean {
  if (
    prev.active !== next.active ||
    prev.watched !== next.watched ||
    prev.refused !== next.refused ||
    prev.full !== next.full ||
    prev.onOpen !== next.onOpen ||
    prev.onWatch !== next.onWatch ||
    prev.row.source !== next.row.source
  ) {
    return false;
  }
  const time = prev.row.latestSignal?.timeMs;
  if (time !== next.row.latestSignal?.timeMs) return false;
  if (time === undefined) return true;
  return formatSignalAge(Math.max(0, prev.now - time)) === formatSignalAge(Math.max(0, next.now - time));
}

function RegimeCell({ regime, row }: { readonly regime: Regime | null; readonly row: OverviewRow }) {
  return (
    <td className={`regime regime-${regimeTone(regime)}`} title={regimeTitle(regime, row.instrument)}>
      {regimeLabel(regime)}
    </td>
  );
}

/**
 * Every product at a glance (the Overview tab): price and change, session range, volume, spread, activity, order
 * flow, the 5- and 15-minute regimes and whether they agree, the newest signal and the feed's health. Reads only the
 * polled GET /api/instruments list, so it needs no hub subscription and draws no chart. Grouped like the picker
 * until a column header sorts it; a product's button opens it on the Detail tab.
 */
export const OverviewTable = memo(function OverviewTable({ summaries, watchlist, active, onOpen, refused, onWatch }: OverviewTableProps) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<OverviewSort>(null);
  // Signal ages are shown to the minute, so a coarse clock is enough.
  const now = useNow(5000);
  const groups = useMemo(
    () =>
      sort === null
        ? groupSummaries(summaries, watchlist, filter).map((g) => ({ title: g.title, rows: g.items.map(overviewRow) }))
        : [{ title: null, rows: sortedOverview(summaries, filter, sort.key, sort.direction) }],
    [summaries, watchlist, filter, sort],
  );
  const watchedSet = useMemo(() => new Set(watchlist), [watchlist]);
  const refusedSet = useMemo(() => new Set(refused), [refused]);
  const full = watchlist.length >= watchlistLimit;
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <main className="overview" aria-label="Overview of every product">
      <div className="overview-head">
        <h2>
          All products <span className="muted">({shown} of {summaries.length})</span>
        </h2>
        {summaries.length > 0 && (
          <ul className="overview-status" aria-label="Feed status across products">
            {statusCounts(summaries).map(([code, n]) => (
              <li key={code}>
                <span className={`chip chip-small chip-${chipTone(code)}`}>{code}</span> <span className="num">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="overview-filters">
        <label className="field">
          <span className="visually-hidden">Filter products</span>
          <input type="search" placeholder="filter root or name" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {sort !== null && (
          <button type="button" onClick={() => setSort(null)}>
            Group by sector
          </button>
        )}
        <ChangeServerButton />
      </div>
      <div className="scroll overview-box">
        {shown === 0 ? (
          <p className="muted">{summaries.length === 0 ? "No products listed yet." : "No product matches the filter."}</p>
        ) : (
          <table className="compact products-table overview-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Watchlist</span>
                </th>
                {columns.map(([key, label, title]) => (
                  <th key={key} scope="col" aria-sort={sort?.key === key ? sort.direction : "none"}>
                    <button type="button" className="sort" title={`${title}. Sort.`} onClick={() => setSort(nextSort(sort, key))}>
                      {label}
                      <span aria-hidden="true">{sort?.key === key ? (sort.direction === "ascending" ? " ▲" : " ▼") : ""}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.title ?? "sorted"}>
                {group.title !== null && (
                  <tr className="group">
                    <th scope="colgroup" colSpan={columns.length + 1}>
                      {group.title}
                      <span className="count">{group.rows.length}</span>
                    </th>
                  </tr>
                )}
                {group.rows.map((row) => (
                  <OverviewDataRow
                    key={row.instrument.root}
                    row={row}
                    active={row.instrument.root === active}
                    now={now}
                    watched={watchedSet.has(row.instrument.root)}
                    refused={refusedSet.has(row.instrument.root)}
                    full={full}
                    onOpen={onOpen}
                    onWatch={onWatch}
                  />
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </main>
  );
});
