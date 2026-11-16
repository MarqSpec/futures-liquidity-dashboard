import { useSyncExternalStore } from "react";

import { colorTheme, type ColorTheme, type ThemeChoice } from "../lib/colorTheme.ts";


/** The theme names the viewer sees: Terminal is the dark theme. */
const themeNames = { dark: "Terminal", light: "Light" } as const;

function isChoice(value: string): value is ThemeChoice {
  return value === "system" || value === "dark" || value === "light";
}

/** Props of the theme control. */
export interface ThemeControlProps {
  /** The theme it reads and changes; the app's by default. */
  readonly controller?: ColorTheme;
}

/** A small menu in the top bar: Match system (naming the theme it gives now), Terminal or Light. Applies at once. */
export function ThemeControl({ controller = colorTheme }: ThemeControlProps) {
  const { choice, theme } = useSyncExternalStore(controller.subscribe, controller.state, controller.state);
  const system = choice === "system" ? theme : null;

  return (
    <select
      className="theme-control"
      aria-label="Theme"
      value={choice}
      onChange={(event) => {
        if (isChoice(event.target.value)) controller.choose(event.target.value);
      }}
    >
      <option value="system">{system ? `Match system (${themeNames[system]})` : "Match system"}</option>
      <option value="dark">{themeNames.dark}</option>
      <option value="light">{themeNames.light}</option>
    </select>
  );
}
