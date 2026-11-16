import { memo, useMemo, useState } from "react";

import type { InstrumentSummary } from "../api/schemas.ts";
import { watchlistLimit } from "../domain/layout.ts";
import { groupProducts, productRow, type ProductRow } from "../domain/products.ts";
import { readStored, writeStored } from "../lib/storage.ts";

/** Props of the product picker. */
export interface ProductPanelProps {
  readonly summaries: readonly InstrumentSummary[];
  readonly watchlist: readonly string[];
  /** The product the charts show. */
  readonly active: string;
  /** Watched roots the server would not pull depth for. */
  readonly refused: readonly string[];
  readonly onSelect: (root: string) => void;
  readonly onWatch: (root: string, on: boolean) => void;
}

const COLLAPSED_KEY = "futures-liquidity-dashboard.products-collapsed";
const COLUMNS = 10;

interface StarProps {
  readonly root: string;
  readonly watched: boolean;
  readonly refused: boolean;
  readonly full: boolean;
  readonly onWatch: (root: string, on: boolean) => void;
}

/** The watchlist star: an icon button, disabled when the watchlist is full and this product is not on it. */
export function Star({ root, watched, refused, full, onWatch }: StarProps) {
  const title = refused
    ? "no depth: limit reached"
    : watched
      ? "watched: depth kept"
      : full
        ? `watchlist full (${watchlistLimit})`
        : "watch: keep depth";
  return (
    <button
      type="button"
      className={`icon-button star${watched ? " star-on" : ""}${refused ? " star-refused" : ""}`}
      aria-pressed={watched}
      aria-label={watched ? `Remove ${root} from the watchlist` : `Add ${root} to the watchlist`}
      title={title}
      disabled={!watched && full}
      onClick={() => onWatch(root, !watched)}
    >
      {watched && !refused ? "★" : "☆"}
    </button>
  );
}

/**
 * Every product the viewer may see, one row each: the watchlist first, then the rest by sector, with the last
 * price, the change from the session open, the spread, session volume, CVD, the feed status and whether the server
 * holds its depth. A filter narrows it; a row's button selects the product the charts show; the star adds it to the
 * watchlist. It opens collapsed to one row, the watched products as small buttons beside the filter, until the viewer
 * has chosen otherwise (D-44); typing in the filter opens the table. A plain table, re-rendered only when the
 * polled summaries, the watchlist or the selection change.
 */
export const ProductPanel = memo(function ProductPanel({ summaries, watchlist, active, refused, onSelect, onWatch }: ProductPanelProps) {
  const [collapsed, setCollapsed] = useState(() => readStored(COLLAPSED_KEY) !== false);
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => groupProducts(summaries, watchlist, filter), [summaries, watchlist, filter]);
  const watchedRows = useMemo(() => {
    const byRoot = new Map(summaries.map((s) => [s.instrument.root, s]));
    return watchlist.flatMap((root) => {
      const summary = byRoot.get(root);
      return summary ? [productRow(summary)] : [];
    });
  }, [summaries, watchlist]);
  const refusedSet = useMemo(() => new Set(refused), [refused]);
  const watched = useMemo(() => new Set(watchlist), [watchlist]);
  const full = watchlist.length >= watchlistLimit;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeStored(COLLAPSED_KEY, next);
  };

  // Typing is a request to see the matches, so it opens the table. That is not the viewer's stored choice.
  const changeFilter = (value: string) => {
    setFilter(value);
    if (value !== "") {
      setCollapsed(false);
    }
  };

  const renderRow = (row: ProductRow) => {
    const isActive = row.root === active;
    return (
      <tr key={row.root} className={isActive ? "active" : undefined}>
        <td>
          <Star root={row.root} watched={watched.has(row.root)} refused={refusedSet.has(row.root)} full={full} onWatch={onWatch} />
        </td>
        <td className="product">
          <button
            type="button"
            className="select"
            aria-pressed={isActive}
            aria-label={`Chart ${row.root}, ${row.name}`}
            title={row.name}
            onClick={() => onSelect(row.root)}
          >
            <strong>{row.root}</strong> <span className="muted name">{row.name}</span>
          </button>
        </td>
        <td className="num">{row.last}</td>
        <td className={`num dir-${row.changeDirection}`}>{row.change}</td>
        <td className={`num dir-${row.changeDirection}`}>{row.changePercent}</td>
        <td className="num">{row.spread}</td>
        <td className="num">{row.volume}</td>
        <td className={`num dir-${row.cvdDirection}`}>{row.cvd}</td>
        <td>
          <span className={`chip chip-small chip-${row.tone}`}>{row.code}</span>
        </td>
        <td>{row.depth && <span className="dom-mark" title="The server holds this product's depth">DOM</span>}</td>
      </tr>
    );
  };

  return (
    <section className={`panel products${collapsed ? " collapsed" : ""}`} aria-label="Products">
      <div className="products-head">
        <button type="button" className="collapse" aria-expanded={!collapsed} aria-controls="products-table" onClick={toggle}>
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span> Products <span className="muted">{summaries.length}</span>
        </button>
        {collapsed && (
          <ul className="quick-list" aria-label="Watchlist">
            {watchedRows.map((row) => (
              <li key={row.root}>
                <button
                  type="button"
                  className="small"
                  aria-pressed={row.root === active}
                  title={`${row.name}, last ${row.last} ${row.changePercent}`}
                  onClick={() => onSelect(row.root)}
                >
                  <span className="watch-star" aria-hidden="true">
                    ★
                  </span>
                  <span className="root">{row.root}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="field products-filter">
          <span className="visually-hidden">Filter products</span>
          <input type="search" placeholder="filter root or name" value={filter} onChange={(e) => changeFilter(e.target.value)} />
        </label>
      </div>
      {!collapsed && (
        <div className="scroll" id="products-table">
          {groups.length === 0 ? (
            <p className="muted">{summaries.length === 0 ? "No products listed yet." : "No product matches the filter."}</p>
          ) : (
            <table className="compact products-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Watch</span>
                  </th>
                  <th scope="col">Product</th>
                  <th scope="col">Last</th>
                  <th scope="col">Chg</th>
                  <th scope="col">Chg %</th>
                  <th scope="col" title="Spread in ticks">Spr</th>
                  <th scope="col">Vol</th>
                  <th scope="col">CVD</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Depth</span>
                  </th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.title}>
                  <tr className="group">
                    <th scope="colgroup" colSpan={COLUMNS}>
                      {group.title}
                    </th>
                  </tr>
                  {group.rows.map(renderRow)}
                </tbody>
              ))}
            </table>
          )}
        </div>
      )}
    </section>
  );
});
