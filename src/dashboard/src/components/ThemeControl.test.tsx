// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { ThemeId } from "../design/tokenFile.ts";
import { createColorTheme, THEME_STORAGE_KEY } from "../lib/colorTheme.ts";
import { ThemeControl } from "./ThemeControl.tsx";

// The top bar's theme control: Match system, Terminal or Light, applied at once with no reload.

afterEach(cleanup);

function controller(prefersLight = false, stored: string | null = null) {
  const items = new Map<string, string>(stored ? [[THEME_STORAGE_KEY, stored]] : []);
  const applied: ThemeId[] = [];
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as unknown as Storage;
  const theme = createColorTheme({
    storage: () => storage,
    media: () => ({ matches: prefersLight, addEventListener: () => undefined, removeEventListener: () => undefined }),
    apply: (next) => applied.push(next),
  });
  return { theme, applied, items };
}

describe("ThemeControl", () => {
  it("should offer Match system, Terminal and Light and show Match system when nothing is stored", () => {
    const { theme } = controller(true);
    render(<ThemeControl controller={theme} />);

    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" });
    expect([...select.options].map((option) => [option.value, option.text])).toEqual([
      ["system", "Match system (Light)"],
      ["dark", "Terminal"],
      ["light", "Light"],
    ]);
    expect(select.value).toBe("system");
  });

  it("should show the stored choice when one was kept in this browser", () => {
    const { theme } = controller(true, "dark");
    render(<ThemeControl controller={theme} />);

    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value).toBe("dark");
  });

  it("should apply and store Light at once when the viewer picks it", async () => {
    const user = userEvent.setup();
    const { theme, applied, items } = controller(false);
    render(<ThemeControl controller={theme} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Theme" }), "Light");

    expect(applied.at(-1)).toBe("light");
    expect(items.get(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value).toBe("light");
  });

  it("should name the theme Match system resolves to when the OS setting is dark", () => {
    const { theme } = controller(false);
    render(<ThemeControl controller={theme} />);

    expect(screen.getByRole("option", { name: "Match system (Terminal)" })).toBeTruthy();
  });
});
