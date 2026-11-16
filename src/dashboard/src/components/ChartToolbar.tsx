import { hints } from "../domain/hints.ts";
import { chartIntervals, heatModes, historyChoices, indicatorIntervals, type HeatMode } from "../domain/layout.ts";
import type { LayoutSource } from "../hooks/useLayout.ts";
import { Hint } from "./Hint.tsx";

/** Props of the chart toolbar. */
export interface ChartToolbarProps {
  readonly historyMinutes: number;
  readonly chartMinutes: number;
  readonly indicatorMinutes: number;
  readonly heatMode: HeatMode;
  readonly heatContrast: number;
  readonly layoutSource: LayoutSource;
  readonly following: boolean;
  readonly onHistory: (minutes: number) => void;
  readonly onChartMinutes: (minutes: number) => void;
  readonly onIndicatorMinutes: (minutes: number) => void;
  readonly onHeatMode: (mode: HeatMode) => void;
  readonly onContrast: (value: number) => void;
  readonly onZoom: (factor: number) => void;
  readonly onLive: () => void;
}

/**
 * The chart controls in one row under the status bar: the bar interval, the history window, the EMA timeframe and
 * the heatmap mode as labelled button groups, then the contrast slider, zoom, Live and where the layout is saved.
 * It wraps on a narrow window. Each group is a fieldset whose legend names it.
 */
export function ChartToolbar(props: ChartToolbarProps) {
  const { historyMinutes, chartMinutes, indicatorMinutes, heatMode, heatContrast, layoutSource, following } = props;
  return (
    <div className="chart-toolbar" role="toolbar" aria-label="Chart controls">
      <fieldset className="segmented">
        <legend>Bars</legend>
        {chartIntervals.map((minutes) => (
          <button key={minutes} type="button" aria-pressed={chartMinutes === minutes} onClick={() => props.onChartMinutes(minutes)}>
            {minutes}m
          </button>
        ))}
      </fieldset>
      <fieldset className="segmented">
        <legend>Window</legend>
        {historyChoices.map(([minutes, label]) => (
          <button key={minutes} type="button" aria-pressed={historyMinutes === minutes} onClick={() => props.onHistory(minutes)}>
            {label}
          </button>
        ))}
      </fieldset>
      <fieldset className="segmented">
        <legend>EMA timeframe</legend>
        {indicatorIntervals.map((minutes) => (
          <button
            key={minutes}
            type="button"
            aria-pressed={indicatorMinutes === minutes}
            title="Indicator source timeframe, independent of the chart interval"
            onClick={() => props.onIndicatorMinutes(minutes)}
          >
            {minutes}m
          </button>
        ))}
      </fieldset>
      <fieldset className="segmented">
        <legend>Heatmap</legend>
        {heatModes.map((mode) => (
          <button key={mode} type="button" aria-pressed={heatMode === mode} onClick={() => props.onHeatMode(mode)}>
            {mode === "intensity" ? "Heat" : "Added/pulled"}
          </button>
        ))}
      </fieldset>
      <Hint label="contrast" text={hints.heatContrast}>
        {(hint) => (
          <label className="field contrast">
            <span>contrast</span>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              value={heatContrast}
              onChange={(e) => props.onContrast(Number(e.target.value))}
              {...hint}
            />
          </label>
        )}
      </Hint>
      <fieldset className="segmented">
        <legend className="visually-hidden">Zoom</legend>
        <button type="button" aria-label="Zoom in" onClick={() => props.onZoom(1 / 1.5)}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => props.onZoom(1.5)}>
          −
        </button>
      </fieldset>
      <Hint label="Live" text={hints.live}>
        {(hint) => (
          <button type="button" className="filled live" aria-pressed={following} onClick={props.onLive} {...hint}>
            Live
          </button>
        )}
      </Hint>
      <span className="stat muted layout-saved" title="Where the layout is saved">
        layout: {layoutSource === "server" ? "saved" : layoutSource === "browser" ? "this browser" : "…"}
      </span>
    </div>
  );
}
