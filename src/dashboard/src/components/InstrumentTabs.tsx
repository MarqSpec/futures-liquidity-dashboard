import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { InstrumentSummary } from "../api/schemas.ts";
import { watchlistLimit } from "../domain/layout.ts";
import { lastPriceText, nearestLevelText, recentTouches, sessionChange, touchOutcomeText, vwapPosition } from "../domain/quote.ts";

/** Props of the favorites menu that replaced the instrument tab row. */
export interface InstrumentTabsProps {
  readonly selected: string;
  readonly quotes: readonly InstrumentSummary[];
  readonly watchlist: readonly string[];
  readonly onSelect: (root: string) => void;
  readonly onWatch: (root: string, on: boolean) => void;
  /** Opens a product in Detail, from a touch chip. */
  readonly onOpen: (root: string) => void;
}

/**
 * Favorites for Detail and Bookmap. The open product, its last price and the session change sit on one button.
 * The menu switches to any favorite, removes one, or adds a product the server has listed. A lane under it
 * still lists recent level touches (REQUIREMENTS.md FR-10), starred products first, each with how its touches ended and
 * opening its product in Detail (FR-79).
 */
export function InstrumentTabs({ selected, quotes, watchlist, onSelect, onWatch, onOpen }: InstrumentTabsProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const byRoot = useMemo(() => new Map(quotes.map((quote) => [quote.instrument.root, quote])), [quotes]);
  const touches = recentTouches(quotes, watchlist);
  const selectedQuote = byRoot.get(selected);
  const spec = selectedQuote?.instrument ?? { tickSize: 0.25, priceDecimals: 2 };
  const change = selectedQuote?.changeTicks ?? null;
  const full = watchlist.length >= watchlistLimit;
  const needle = filter.trim().toUpperCase();
  const watched = new Set(watchlist);
  const addable = quotes
    .map((quote) => quote.instrument.root)
    .filter((root) => !watched.has(root) && (needle.length === 0 || root.includes(needle)))
    .slice(0, 8);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="instrument-strip">
      <div className="favorites" ref={rootRef}>
        <button
          type="button"
          className="favorites-toggle"
          id={`instrument-tab-${selected}`}
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="tab-root">{selected}</span>
          <span className="tab-last">{selectedQuote ? lastPriceText(selectedQuote.lastTicks, spec) : "…"}</span>
          <span className={change != null && change < 0 ? "tab-change down" : "tab-change"}>
            {selectedQuote ? sessionChange(change, spec.tickSize, spec.priceDecimals) : ""}
          </span>
          <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div className="favorites-menu" id={menuId} aria-label="Favorites">
            <p className="muted">
              {selectedQuote ? `${vwapPosition(selectedQuote.lastTicks, selectedQuote.vwapTicks)} · ${nearestLevelText(selectedQuote)}` : "no quote yet"}
            </p>
            {watchlist.length === 0 && <p className="muted">No favorites yet</p>}
            {watchlist.map((root) => {
              const quote = byRoot.get(root);
              const rowSpec = quote?.instrument ?? spec;
              return (
                <div className="favorites-row" key={root}>
                  <button
                    type="button"
                    className="select"
                    aria-current={selected === root ? "true" : undefined}
                    aria-label={`Chart ${root}`}
                    onClick={() => {
                      onSelect(root);
                      setOpen(false);
                    }}
                  >
                    <strong>{root}</strong>
                    <span className="tab-last">{quote ? lastPriceText(quote.lastTicks, rowSpec) : "…"}</span>
                  </button>
                  <button type="button" aria-label={`Remove ${root} from the watchlist`} onClick={() => onWatch(root, false)}>
                    Remove
                  </button>
                </div>
              );
            })}
            <div className="favorites-add">
              <label>
                Add favorite
                <input
                  value={filter}
                  placeholder="Root"
                  aria-label="Filter products to add"
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              {addable.length === 0 ? (
                <p className="muted">{full ? `Watchlist full (${watchlistLimit})` : "No other product matches"}</p>
              ) : (
                addable.map((root) => (
                  <button key={root} type="button" disabled={full} aria-label={`Add ${root} to the watchlist`} onClick={() => onWatch(root, true)}>
                    Add {root}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      <ul className="touch-lane" aria-label="Recent level touches">
        {touches.length === 0 ? (
          <li className="muted">No level touches yet</li>
        ) : (
          touches.map((touch) => (
            <li key={`${touch.root}-${touch.level.name}-${touch.level.priceTicks}`} className={touch.level.isThirdTouch ? "third" : undefined}>
              <button type="button" title={`Open ${touch.root} in Detail`} onClick={() => onOpen(touch.root)}>
                <strong>{touch.root}</strong> {touch.level.name} {touchOutcomeText(touch.level)}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
