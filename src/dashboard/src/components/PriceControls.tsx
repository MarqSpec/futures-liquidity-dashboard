import { chartZoomIn, chartZoomOut } from "../domain/chartCursor.ts";
import type { PriceActions } from "../hooks/usePriceControls.ts";

/** Props of the Price group. */
export interface PriceControlsProps {
  /** The saved Lock, `layout.centerPrice`. */
  readonly locked: boolean;
  /** False before the first trade, when there is no last price to centre. */
  readonly canCenter: boolean;
  readonly actions: PriceActions;
}

/**
 * The +, −, Fit, Center and Lock buttons. Detail and Order Flow both render this one group, over `usePriceControls`,
 * so the two tabs show the same names and tooltip and do the same thing (REQUIREMENTS.md FR-67, FR-68).
 */
export function PriceControls({ locked, canCenter, actions }: PriceControlsProps) {
  return (
    <fieldset>
      <legend>Price</legend>
      <button type="button" aria-label="Zoom price in" onClick={() => actions.zoomBy(chartZoomIn)}>
        +
      </button>
      <button type="button" aria-label="Zoom price out" onClick={() => actions.zoomBy(chartZoomOut)}>
        −
      </button>
      <button type="button" onClick={actions.fit}>
        Fit
      </button>
      <button type="button" aria-label="Center price" disabled={!canCenter} onClick={actions.center}>
        Center
      </button>
      <button
        type="button"
        aria-label="Lock center"
        aria-pressed={locked}
        title="Keep the last price in the middle. A vertical drag or a price zoom, including + and −, turns this off. A sideways drag does not."
        onClick={actions.toggleLock}
      >
        Lock
      </button>
    </fieldset>
  );
}
