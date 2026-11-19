import type { IndicatorSeries } from "../domain/merge.ts";
import { nextHeatCutoffs, withRipsPreset, type LayoutSettings, type PaneId } from "../domain/layout.ts";
import { RangeZoneControls } from "./RangeZoneControls.tsx";
import { SidePanel, type SideFold } from "./SidePanel.tsx";

/** Props of the layer toggles. */
export interface LayersPanelProps {
  readonly isPaneOn: (pane: PaneId) => boolean;
  readonly onToggle: (pane: PaneId, on: boolean) => void;
  readonly indicators: readonly IndicatorSeries[];
  readonly layout: LayoutSettings;
  readonly onReading: (change: (current: LayoutSettings) => LayoutSettings) => void;
  readonly fold?: SideFold;
}

const groups: readonly { readonly title: string; readonly panes: readonly (readonly [PaneId, string])[] }[] = [
  {
    title: "Chart",
    panes: [
      ["heatmap", "Liquidity heatmap"],
      ["vwap", "Session VWAP ±1σ ±2σ"],
      ["overlay", "Agent overlay"],
    ],
  },
  {
    title: "Moving averages",
    panes: [
      ["ema10", "EMA 10"],
      ["ema13", "EMA 13"],
      ["ema24", "EMA 24"],
      ["ema48", "EMA 48"],
      ["ema200", "EMA 200"],
    ],
  },
  {
    title: "Side panels",
    panes: [
      ["ladder", "DOM ladder"],
      ["profile-session", "Profile: session"],
      ["profile-1h", "Profile: 1h"],
      ["profile-4h", "Profile: 4h"],
      ["profile-5d", "Profile: 5 days"],
    ],
  },
];

/** The colour token each drawn layer uses on the chart, shown as a swatch beside its name. */
const swatchTokens: Readonly<Partial<Record<PaneId, string>>> = {
  vwap: "vwap",
  ema10: "ema-10",
  ema13: "ema-13",
  ema24: "ema-24",
  ema48: "ema-48",
  ema200: "ema-200",
};

/** One checkbox per chart layer. The indicator dock is the tab strip under the Detail chart, not a checkbox here. */
export function LayersPanel({ isPaneOn, onToggle, indicators, layout, onReading, fold }: LayersPanelProps) {
  const warmup = (pane: PaneId) => {
    const series = indicators.find((i) => i.id === pane);
    return series && !series.ready ? ` (warming up ${series.seen}/${series.warmup})` : "";
  };
  return (
    <SidePanel label="Layers" title="Layers" fold={fold}>
      <fieldset>
        <legend>Reading</legend>
        <label className="toggle">
          <input
            type="checkbox"
            checked={layout.showVolumeDots}
            onChange={(e) => onReading((current) => ({ ...current, showVolumeDots: e.target.checked }))}
          />
          Volume dots
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={layout.showCandles}
            onChange={(e) => onReading((current) => ({ ...current, showCandles: e.target.checked }))}
          />
          Candles
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={layout.preset === "rips"}
            onChange={(e) => onReading((current) => withRipsPreset(current, e.target.checked))}
          />
          RIPS layout
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={layout.hideValueArea}
            onChange={(e) => onReading((current) => ({ ...current, hideValueArea: e.target.checked }))}
          />
          Hide VAH/VAL
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={layout.heatAutoContrast}
            onChange={(e) => onReading((current) => ({ ...current, heatAutoContrast: e.target.checked }))}
          />
          Heat auto contrast
        </label>
        <label className="toggle">
          dimming
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            aria-label="Heatmap dimming"
            value={layout.heatDim}
            onChange={(e) => onReading((current) => ({ ...current, heatDim: Number(e.target.value) }))}
          />
        </label>
        <label className="toggle">
          lower cutoff
          <input
            type="range"
            min={0}
            max={99}
            step={1}
            aria-label="Heatmap lower percentile"
            value={layout.heatLowPercentile}
            onChange={(e) => onReading((current) => ({ ...current, ...nextHeatCutoffs(current.heatLowPercentile, current.heatHighPercentile, "low", Number(e.target.value)) }))}
          />
        </label>
        <label className="toggle">
          upper cutoff
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            aria-label="Heatmap upper percentile"
            value={layout.heatHighPercentile}
            onChange={(e) => onReading((current) => ({ ...current, ...nextHeatCutoffs(current.heatLowPercentile, current.heatHighPercentile, "high", Number(e.target.value)) }))}
          />
        </label>
        <label className="toggle">
          min dot size
          <input
            type="number"
            min={1}
            max={10000}
            aria-label="Minimum dot size"
            value={layout.dotMinQuantity}
            onChange={(e) => onReading((current) => ({ ...current, dotMinQuantity: Math.max(1, Number(e.target.value) || 1) }))}
          />
        </label>
      </fieldset>
      {groups.map((group) => (
        <fieldset key={group.title}>
          <legend>{group.title}</legend>
          {group.panes.map(([pane, label]) => (
            <label key={pane} className="toggle">
              <input type="checkbox" checked={isPaneOn(pane)} onChange={(e) => onToggle(pane, e.target.checked)} />
              {swatchTokens[pane] !== undefined && <span className="toggle-swatch" aria-hidden="true" style={{ background: `var(--${swatchTokens[pane]})` }} />}
              {label}
              <span className="muted">
                {indicators.find((series) => series.id === pane)?.tf
                  ? ` · ${((indicators.find((series) => series.id === pane)?.tf ?? 60) / 60).toString()}m source`
                  : ""}
                {warmup(pane)}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <RangeZoneControls layout={layout} onReading={onReading} variant="layers" />
    </SidePanel>
  );
}
