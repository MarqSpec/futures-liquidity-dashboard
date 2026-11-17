import { useId, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";

import { CHART_COLOR_GROUPS, CHART_COLOR_ROLES, resolveChartColor, roleContrast, type ChartColorRole, type ChartMark } from "../design/chartColors.ts";
import type { ThemeId } from "../design/tokenFile.ts";
import { tokens } from "../design/tokens.ts";
import { useCanvasTheme } from "../hooks/useCanvasTheme.ts";
import { chartColorStore, type ChartColorStore } from "../lib/chartColorOverrides.ts";

// The viewer's chart colours, per role and per theme, kept in this browser: a picker, a sample of the mark, its worst
// contrast with a warning below its NFR-8 floor (the choice still stands), a reset per role and a Reset all.

const themeNames: Readonly<Record<ThemeId, string>> = { dark: "Terminal", light: "Light" };

const floorNames = { text: "text", graphic: "lines", none: "" } as const;

/** The mark drawn in `colour`, as a small sample beside its picker. */
function sampleStyle(mark: ChartMark, colour: string): CSSProperties {
  switch (mark) {
    case "text":
      return { color: colour };
    case "line":
      return { borderTopColor: colour };
    case "ring":
      return { borderColor: colour };
    case "dot":
    case "bar":
    case "fill":
      return { background: colour };
  }
}

interface RoleRowProps {
  readonly role: ChartColorRole;
  readonly theme: ThemeId;
  readonly store: ChartColorStore;
}

function RoleRow({ role, theme, store }: RoleRowProps) {
  const id = useId();
  const overrides = useSyncExternalStore(store.subscribe, store.overrides, store.overrides)[theme];
  const value = resolveChartColor(tokens, role.token, theme, overrides);
  const contrast = roleContrast(tokens, role.token, value, theme, overrides);
  const overridden = Object.hasOwn(overrides, role.token);
  return (
    <div className="chart-color-row" title={role.marks}>
      <input
        id={`${id}-input`}
        type="color"
        value={value}
        aria-describedby={`${id}-contrast`}
        onChange={(event) => store.set(theme, role.token, event.target.value)}
      />
      <label htmlFor={`${id}-input`}>{role.name}</label>
      {role.mark === "text" ? (
        <span className="chart-color-sample chart-color-sample--text" aria-hidden="true" style={sampleStyle(role.mark, value)}>
          Aa
        </span>
      ) : (
        <span className={`chart-color-sample chart-color-sample--${role.mark}`} aria-hidden="true" style={sampleStyle(role.mark, value)} />
      )}
      <span id={`${id}-contrast`} className={contrast.below ? "chart-color-contrast chart-color-warning" : "chart-color-contrast"}>
        {`${contrast.ratio.toFixed(1)}:1 at worst`}
        {contrast.below && <strong>{` Below its ${contrast.minimum}:1 floor for ${floorNames[role.floor]}.`}</strong>}
      </span>
      <button type="button" className="chart-color-reset" disabled={!overridden} aria-label={`Reset ${role.name}`} onClick={() => store.reset(theme, role.token)}>
        Reset
      </button>
    </div>
  );
}

interface PanelProps {
  readonly id: string;
  readonly store: ChartColorStore;
  readonly onClose: () => void;
}

function ChartColorPanel({ id, store, onClose }: PanelProps) {
  const headingId = useId();
  const theme = useCanvasTheme();
  const overrides = useSyncExternalStore(store.subscribe, store.overrides, store.overrides)[theme];
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  };

  return (
    <dialog open id={id} className="chart-colors-panel" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <div className="chart-colors-head">
        <h2 id={headingId}>{`Chart colours: ${themeNames[theme]}`}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="chart-colors-note">
        Each colour keeps its meaning on every tab. Saved in this browser for {themeNames[theme]}; switch the theme to set the
        other&apos;s. Contrast is the worst on the chart surfaces; a warning never blocks your choice.
      </p>
      {CHART_COLOR_GROUPS.map((group) => (
        <fieldset key={group} className="chart-colors-group">
          <legend>{group}</legend>
          {CHART_COLOR_ROLES.filter((role) => role.group === group).map((role) => (
            <RoleRow key={role.token} role={role} theme={theme} store={store} />
          ))}
        </fieldset>
      ))}
      <button type="button" className="chart-colors-reset-all" disabled={Object.keys(overrides).length === 0} onClick={() => store.resetAll(theme)}>
        Reset all
      </button>
    </dialog>
  );
}

/** Props of the chart colour settings. */
export interface ChartColorSettingsProps {
  /** The overrides it reads and changes; the app's by default. */
  readonly store?: ChartColorStore;
}

/** A top-bar button that opens the chart colour settings for the active theme. */
export function ChartColorSettings({ store = chartColorStore }: ChartColorSettingsProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div className="chart-colors">
      <button ref={button} type="button" className="chart-colors-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((was) => !was)}>
        Chart colours
      </button>
      {open && <ChartColorPanel id={panelId} store={store} onClose={close} />}
    </div>
  );
}
