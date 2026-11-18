import { useCallback, useState } from "react";
import { useLoaderData, useSearchParams } from "react-router";

import type { SignalKind } from "../api/schemas.ts";
import { BookmapView } from "../components/BookmapView.tsx";
import { ChartToolbar } from "../components/ChartToolbar.tsx";
import { InstrumentTabs } from "../components/InstrumentTabs.tsx";
import { MarketView } from "../components/MarketView.tsx";
import { OverviewTable } from "../components/OverviewTable.tsx";
import { PerfOverlay } from "../components/PerfOverlay.tsx";
import { ProductPanel } from "../components/ProductPanel.tsx";
import { StatusBar } from "../components/StatusBar.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { withPane, withSignal, withWatched, type HeatMode, type PaneId } from "../domain/layout.ts";
import { resolveTab, tabParam, viewTabLabel, withTabParam, type DashboardTab } from "../domain/tabs.ts";
import { clampWindow, defaultWindow, type ViewWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { useInstrumentSummaries } from "../hooks/useInstrumentSummaries.ts";
import { useLayout } from "../hooks/useLayout.ts";
import { useMarketStream } from "../hooks/useMarketStream.ts";
import { perfRequested } from "../lib/perfProbe.ts";
import { readStored, writeStored } from "../lib/storage.ts";
import type { dashboardLoader } from "./dashboardLoader.ts";

/**
 * The read-only dashboard. Overview lists every product from the polled instrument list. Detail and Bookmap chart
 * one instrument from the market hub; Order Flow is the volume-dot layout (`?tab=orderflow`, and `?tab=bookmap` still
 * opens it). The tab is kept in
 * the URL and in this browser; Detail is the default. Nothing on this page places, changes or cancels an order
 * (REQUIREMENTS.md FR-6).
 */
const TAB_KEY = "futures-liquidity-dashboard.tab";

export function DashboardRoute() {
  const instruments = useInstrumentSummaries(useLoaderData<typeof dashboardLoader>());
  const { layout, source, update } = useLayout();
  const view = useMarketStream(layout.instrument, layout.historyMinutes, layout.indicatorMinutes, layout.watchlist);
  const [perf] = useState(() => perfRequested(globalThis.location?.search ?? ""));
  const [params, setParams] = useSearchParams();
  const [storedTab, setStoredTab] = useState(() => readStored(TAB_KEY));
  const tab = resolveTab(params.get(tabParam), storedTab);
  const [crosshair] = useState(createCrosshairStore);
  const [viewWindow, setViewWindow] = useState<ViewWindow>(() => defaultWindow(layout.historyMinutes));
  const market = view.market?.root === layout.instrument ? view.market : null;
  const historyMs = layout.historyMinutes * 60_000;

  const changeWindow = useCallback((change: (current: ViewWindow) => ViewWindow) => setViewWindow(change), []);
  const resetWindow = useCallback(() => setViewWindow(defaultWindow(layout.historyMinutes)), [layout.historyMinutes]);
  // Stable, so the memoised picker does not re-render on every stream update.
  const selectInstrument = useCallback((root: string) => update((l) => ({ ...l, instrument: root })), [update]);
  const selectTab = useCallback(
    (next: DashboardTab) => {
      setStoredTab(next);
      writeStored(TAB_KEY, next);
      setParams((current) => withTabParam(current, next), { replace: true });
    },
    [setParams],
  );
  const openDetail = useCallback(
    (root: string) => {
      update((l) => ({ ...l, instrument: root }));
      selectTab("detail");
    },
    [update, selectTab],
  );
  const watchInstrument = useCallback((root: string, on: boolean) => update((l) => withWatched(l, root, on)), [update]);
  const selectHistory = (minutes: number) => {
    update((l) => ({ ...l, historyMinutes: minutes }));
    setViewWindow(defaultWindow(minutes));
  };
  const togglePane = (pane: PaneId, on: boolean) => update((l) => withPane(l, pane, on));
  const toggleKind = (kind: SignalKind, on: boolean) => update((l) => withSignal(l, kind, on));
  const following = clampWindow(viewWindow, historyMs).offsetMs === 0;

  return (
    <div className="app">
      <TopBar tab={tab} instrument={layout.instrument} view={view} onSelect={selectTab} />
      <div className="view" role="tabpanel" id="view-panel" aria-labelledby={`view-tab-${tab}`}>
        {tab === "overview" ? (
          // The Overview reads only the polled list: no chart is mounted or drawn while it is shown.
          <OverviewTable
            summaries={instruments}
            watchlist={layout.watchlist}
            active={layout.instrument}
            refused={view.refusedRoots}
            onOpen={openDetail}
            onWatch={watchInstrument}
          />
        ) : (
          <>
            <InstrumentTabs
              selected={layout.instrument}
              quotes={instruments}
              watchlist={layout.watchlist}
              onSelect={selectInstrument}
              onWatch={watchInstrument}
            />
            <section id="instrument-panel" className="instrument-panel" aria-label={`${viewTabLabel(tab, layout.instrument)} chart`}>
              <StatusBar
                view={view}
                instrument={layout.instrument}
                instruments={instruments}
              />
              <ChartToolbar
                historyMinutes={layout.historyMinutes}
                chartMinutes={layout.chartMinutes}
                indicatorMinutes={layout.indicatorMinutes}
                heatMode={layout.heatMode}
                heatContrast={layout.heatContrast}
                layoutSource={source}
                following={following}
                onHistory={selectHistory}
                onChartMinutes={(minutes) => update((l) => ({ ...l, chartMinutes: minutes as 1 | 2 | 5 | 15 }))}
                onIndicatorMinutes={(minutes) => update((l) => ({ ...l, indicatorMinutes: minutes as 1 | 5 | 15 }))}
                onHeatMode={(mode: HeatMode) => update((l) => ({ ...l, heatMode: mode }))}
                onContrast={(value) => update((l) => ({ ...l, heatContrast: value }))}
                onZoom={(factor) => setViewWindow((w) => ({ ...w, spanMs: clampWindow(w, historyMs).spanMs * factor }))}
                onLive={() => setViewWindow((w) => ({ ...w, offsetMs: 0 }))}
              />
              <ProductPanel
                summaries={instruments}
                watchlist={layout.watchlist}
                active={layout.instrument}
                refused={view.refusedRoots}
                onSelect={selectInstrument}
                onWatch={watchInstrument}
              />
              {market ? (
                tab === "bookmap" ? (
                  <BookmapView market={market} layout={layout} viewWindow={viewWindow} crosshair={crosshair} onReading={update} onWindow={changeWindow} />
                ) : (
                  <MarketView
                    market={market}
                    layout={layout}
                    viewWindow={viewWindow}
                    crosshair={crosshair}
                    onWindow={changeWindow}
                    onResetWindow={resetWindow}
                    onTogglePane={togglePane}
                    onToggleKind={toggleKind}
                    onReading={update}
                  />
                )
              ) : (
                <main className="placeholder">
                  <p>
                    {view.hub === "connected"
                      ? `Loading the ${layout.instrument} snapshot…`
                      : `Connecting to the market hub (${view.hub})…`}
                  </p>
                  {view.error && <p className="error">{view.error}</p>}
                </main>
              )}
            </section>
          </>
        )}
      </div>
      {perf && <PerfOverlay />}
    </div>
  );
}
