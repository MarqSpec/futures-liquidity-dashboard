import { useCallback, useEffect, useRef, useState } from "react";

import { getLayout, LayoutConflictError, putLayout, type LayoutPut } from "../api/client.ts";
import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { readStoredLayout, reconcileLayout } from "../domain/layoutPersistence.ts";
import { readStored, writeStored } from "../lib/storage.ts";

const STORAGE_KEY = "futures-liquidity-dashboard.layout";
const SAVE_DELAY_MS = 600;

/** Where the layout in use came from, and where changes go. */
export type LayoutSource = "loading" | "server" | "browser";

/** The viewer's layout and a setter that saves it. */
export interface LayoutState {
  readonly layout: LayoutSettings;
  readonly source: LayoutSource;
  readonly update: (change: (current: LayoutSettings) => LayoutSettings) => void;
}

function storedNow(): ReturnType<typeof readStoredLayout> {
  return readStoredLayout(readStored(STORAGE_KEY));
}

function remember(revision: number, layout: LayoutSettings, pending: boolean): void {
  writeStored(STORAGE_KEY, { revision, layout, pending });
}

function copyLayout(layout: LayoutSettings): LayoutSettings {
  return {
    ...layout,
    panes: { ...layout.panes },
    signals: { ...layout.signals },
    watchlist: [...layout.watchlist],
    positions: structuredClone(layout.positions),
    sideSectionsCollapsed: [...layout.sideSectionsCollapsed],
  };
}

function withoutPositions(layout: LayoutSettings): LayoutPut {
  const { positions: _kept, ...rest } = layout;
  return rest;
}

function sameFlags(left: Readonly<Record<string, boolean>>, right: Readonly<Record<string, boolean>>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function sameLayout(left: LayoutSettings, right: LayoutSettings): boolean {
  return (
    left.instrument === right.instrument &&
    left.sliceSeconds === right.sliceSeconds &&
    left.chartMinutes === right.chartMinutes &&
    left.indicatorMinutes === right.indicatorMinutes &&
    left.heatMode === right.heatMode &&
    left.historyMinutes === right.historyMinutes &&
    left.heatContrast === right.heatContrast &&
    left.preset === right.preset &&
    left.showCandles === right.showCandles &&
    left.showVolumeDots === right.showVolumeDots &&
    left.heatDim === right.heatDim &&
    left.heatLowPercentile === right.heatLowPercentile &&
    left.heatHighPercentile === right.heatHighPercentile &&
    left.heatAutoContrast === right.heatAutoContrast &&
    left.dotMinQuantity === right.dotMinQuantity &&
    left.eventDotSize === right.eventDotSize &&
    left.centerPrice === right.centerPrice &&
    left.indicatorPane === right.indicatorPane &&
    left.indicatorDockCollapsed === right.indicatorDockCollapsed &&
    left.detailChart === right.detailChart &&
    left.sideSectionsCollapsed.length === right.sideSectionsCollapsed.length &&
    left.sideSectionsCollapsed.every((key, index) => key === right.sideSectionsCollapsed[index]) &&
    left.showPriceLine === right.showPriceLine &&
    left.hideValueArea === right.hideValueArea &&
    left.emphasizeNodes === right.emphasizeNodes &&
    JSON.stringify(left.positions) === JSON.stringify(right.positions) &&
    sameFlags(left.panes, right.panes) &&
    sameFlags(left.signals, right.signals) &&
    left.watchlist.length === right.watchlist.length &&
    left.watchlist.every((root, index) => root === right.watchlist[index])
  );
}

/**
 * Loads the viewer's layout and saves every change with PUT (debounced). The revision sent is the server counter
 * last read, never this device's clock. A 409 whose document was saved replaces a stale edit. A 409 that reports
 * nothing saved keeps the local layout and retries. A 409 echoes this tab's own save only when its layout is the
 * one this tab sent citing the previous counter, and a newer edit is still pending. Any other saved document is
 * shown. A local document that fails the layout schema is ignored.
 */
export function useLayout(): LayoutState {
  const [layout, setLayout] = useState<LayoutSettings>(() => storedNow()?.layout ?? defaultLayout);
  const [source, setSource] = useState<LayoutSource>("loading");
  const revision = useRef(storedNow()?.revision ?? 0);
  const layoutRef = useRef(layout);
  const dirty = useRef(false);
  // A save sends `positions` only when the viewer changed them, so the server's omit-keeps-stored rule protects any
  // position a filtered or lenient read hid (REQUIREMENTS.md FR-72, ARCHITECTURE.md D-57).
  const positionsDirty = useRef(false);
  const citedWrites = useRef<{ revision: number; layout: LayoutSettings }[]>([]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    const controller = new AbortController();
    getLayout(controller.signal).then(
      (served) => {
        if (controller.signal.aborted) {
          return;
        }
        if (dirty.current) {
          if (!served.saved || revision.current === served.revision) {
            revision.current = served.revision;
            return;
          }
          dirty.current = false;
          positionsDirty.current = false;
          revision.current = served.revision;
          layoutRef.current = served.layout;
          remember(served.revision, served.layout, false);
          setLayout(served.layout);
          setSource("server");
          return;
        }
        const choice = reconcileLayout(storedNow(), served);
        revision.current = choice.revision;
        layoutRef.current = choice.layout;
        setLayout(choice.layout);
        if (choice.push) {
          dirty.current = true;
          positionsDirty.current =
            !served.saved || JSON.stringify(choice.layout.positions) !== JSON.stringify(served.layout.positions);
          remember(choice.revision, choice.layout, true);
          setSource("browser");
        } else {
          if (served.saved) {
            remember(served.revision, served.layout, false);
          }
          setSource("server");
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setSource("browser");
        }
      },
    );
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!dirty.current) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const sent = revision.current;
      const snapshot = layoutRef.current;
      citedWrites.current = [...citedWrites.current.slice(-7), { revision: sent, layout: snapshot }];
      const adopt = (current: LayoutSettings, nextRevision: number): void => {
        revision.current = nextRevision;
        dirty.current = false;
        positionsDirty.current = false;
        layoutRef.current = current;
        remember(nextRevision, current, false);
        setLayout(current);
        setSource("server");
      };
      const retryLocal = (nextRevision: number): void => {
        revision.current = nextRevision;
        dirty.current = true;
        remember(nextRevision, layoutRef.current, true);
        setSource("browser");
        if (sent !== nextRevision) {
          setLayout(copyLayout(layoutRef.current));
        }
      };
      const sendPositions = positionsDirty.current;
      putLayout({ revision: sent, layout: sendPositions ? snapshot : withoutPositions(snapshot) }, controller.signal).then(
        (saved) => {
          if (saved.revision > revision.current) {
            revision.current = saved.revision;
          }
          if (controller.signal.aborted) {
            if (dirty.current) {
              remember(revision.current, layoutRef.current, true);
            }
            return;
          }
          adopt(saved.layout, saved.revision);
        },
        (error: unknown) => {
          if (error instanceof LayoutConflictError) {
            const current = error.document;
            if (!current.saved) {
              retryLocal(current.revision);
              return;
            }
            const echoed = citedWrites.current.some(
              (write) => write.revision === current.revision - 1 && sameLayout(write.layout, current.layout),
            );
            const newerLocal = dirty.current && !sameLayout(layoutRef.current, current.layout);
            if (echoed && newerLocal) {
              if (controller.signal.aborted) {
                revision.current = current.revision;
                remember(current.revision, layoutRef.current, true);
                return;
              }
              retryLocal(current.revision);
              return;
            }
            if (controller.signal.aborted) {
              return;
            }
            adopt(current.layout, current.revision);
            return;
          }
          if (controller.signal.aborted) {
            return;
          }
          remember(sent, snapshot, true);
          setSource("browser");
        },
      );
    }, SAVE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [layout]);

  const update = useCallback((change: (current: LayoutSettings) => LayoutSettings) => {
    const next = change(layoutRef.current);
    if (JSON.stringify(next.positions) !== JSON.stringify(layoutRef.current.positions)) {
      positionsDirty.current = true;
    }
    dirty.current = true;
    layoutRef.current = next;
    remember(revision.current, next, true);
    setLayout(next);
  }, []);

  return { layout, source, update };
}
