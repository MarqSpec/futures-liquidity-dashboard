import { hints } from "../domain/hints.ts";
import { isPaneOn, withPane, type LayoutSettings, type RangeZoneTimeframe } from "../domain/layout.ts";
import { Hint } from "./Hint.tsx";

// reference: REQUIREMENTS.md FR-75, FR-9 (ARCHITECTURE.md D-62)

/** Props of the range-zone controls. */
export interface RangeZoneControlsProps {
  readonly layout: LayoutSettings;
  readonly onReading: (change: (current: LayoutSettings) => LayoutSettings) => void;
  /** `layers`: a checkbox and a select in Detail's Layers panel; `display`: pressed buttons in Order Flow's Display menu. */
  readonly variant: "layers" | "display";
}

const choices: readonly (readonly [RangeZoneTimeframe, string])[] = [
  ["900", "15m"],
  ["300", "5m"],
  ["off", "Off"],
];

/**
 * The "Range zones" layer toggle and the bars that drive the zones. Both are saved on the layout, so Detail and
 * Order Flow show the same zones (REQUIREMENTS.md FR-75).
 */
export function RangeZoneControls({ layout, onReading, variant }: RangeZoneControlsProps) {
  const on = isPaneOn(layout, "range-zones");
  const toggle = () => onReading((current) => withPane(current, "range-zones", !isPaneOn(current, "range-zones")));
  const choose = (value: RangeZoneTimeframe) => onReading((current) => ({ ...current, rangeZoneTimeframe: value }));
  if (variant === "layers") {
    return (
      <fieldset>
        <legend>Range zones</legend>
        <label className="toggle">
          <input type="checkbox" checked={on} onChange={toggle} />
          <span className="toggle-swatch" aria-hidden="true" style={{ background: "var(--range-zone)" }} />
          Range zones
        </label>
        <label className="toggle">
          bars
          <select
            aria-label="Range zone bars"
            value={layout.rangeZoneTimeframe}
            onChange={(e) => {
              const picked = choices.find(([value]) => value === e.target.value);
              if (picked) choose(picked[0]);
            }}
          >
            {choices.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
    );
  }
  return (
    <>
      <div className="bookmap-display-item">
        <Hint label="Range zones" text={hints.displayRangeZones}>
          {(hint) => (
            <button type="button" {...hint} aria-pressed={on} onClick={toggle}>
              Range zones
            </button>
          )}
        </Hint>
      </div>
      <div className="bookmap-display-item">
        <Hint label="Range zone bars" text={hints.displayRangeZoneBars}>
          {(hint) => (
            <fieldset {...hint}>
              <legend>Range zone bars</legend>
              {choices.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={layout.rangeZoneTimeframe === value} onClick={() => choose(value)}>
                  {label}
                </button>
              ))}
            </fieldset>
          )}
        </Hint>
      </div>
    </>
  );
}
