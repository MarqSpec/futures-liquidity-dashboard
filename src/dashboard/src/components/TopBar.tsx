import { useRef, type KeyboardEvent } from "react";

import type { StreamView } from "../api/marketStream.ts";
import { formatChicagoTime, formatLocalTime } from "../domain/format.ts";
import { viewTabLabel, viewTabOrder, type DashboardTab } from "../domain/tabs.ts";
import { ThemeControl } from "./ThemeControl.tsx";

/** Props of the app frame's top bar. */
export interface TopBarProps {
  readonly tab: DashboardTab;
  readonly instrument: string;
  readonly view: StreamView;
  readonly onSelect: (tab: DashboardTab) => void;
}

const hubLabels = {
  connecting: "connecting…",
  connected: "connected",
  reconnecting: "reconnecting…",
  disconnected: "disconnected",
} as const;

/**
 * The top of the page: the product name, the view tabs, then the exchange session, the market hub's state, the
 * exchange clock and the theme control. Arrow keys, Home and End move between the tabs and select the one they land on.
 */
export function TopBar({ tab, instrument, view, onSelect }: TopBarProps) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const status = view.market?.status ?? null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = viewTabOrder.indexOf(tab);
    const last = viewTabOrder.length - 1;
    const target =
      event.key === "ArrowRight" ? (at === last ? 0 : at + 1)
      : event.key === "ArrowLeft" ? (at === 0 ? last : at - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    const next = viewTabOrder[target];
    if (next) {
      onSelect(next);
      tabs.current[target]?.focus();
    }
  };

  return (
    <header className="top-bar">
      <span className="product-name">Liquidity Dashboard</span>
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- the tabs inside are the focusable elements */}
      <div className="view-tabs" role="tablist" aria-label="View" onKeyDown={onKeyDown}>
        {viewTabOrder.map((id, index) => (
          <button
            key={id}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`view-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="view-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => onSelect(id)}
          >
            {viewTabLabel(id, instrument)}
          </button>
        ))}
      </div>
      <div className="top-bar-status">
        <span className={status?.exchangeOpen ? "pill pill-open" : "pill"}>
          {status ? (status.exchangeOpen ? "Market open" : "Closed") : "session —"}
        </span>
        <span className="hub-state">
          <span className="visually-hidden">hub </span>
          <span className={`hub hub-${view.hub}`}>{hubLabels[view.hub]}</span>
        </span>
        {view.market && (
          <span className="clock" title={formatLocalTime(view.market.serverTimeMs)}>
            {formatChicagoTime(view.market.serverTimeMs)}
          </span>
        )}
        <ThemeControl />
      </div>
    </header>
  );
}
