// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { color } from "../design/tokens.ts";
import type { ThemeId } from "../design/tokenFile.ts";
import { canvasTheme } from "../theme.ts";
import { applyDocumentTheme, colorTheme, createColorTheme, THEME_STORAGE_KEY, type ColorThemeEnvironment } from "./colorTheme.ts";

// The theme: Terminal or Light, following the OS setting until the viewer chooses, remembered in this browser only.

/** A stand-in for `matchMedia("(prefers-color-scheme: light)")` whose answer a test can change. */
function fakeMedia(prefersLight: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: prefersLight,
    addEventListener: (_type: "change", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: () => void) => listeners.delete(listener),
  };
  return {
    media,
    change(next: boolean) {
      media.matches = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** A Map-backed `Storage` for one browser profile: a second controller over it is a reload. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const items = new Map(Object.entries(initial));
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function environment(overrides: Partial<ColorThemeEnvironment> = {}) {
  const applied: ThemeId[] = [];
  const env: ColorThemeEnvironment = {
    storage: () => fakeStorage(),
    media: () => fakeMedia(false).media,
    apply: (theme) => applied.push(theme),
    ...overrides,
  };
  return { env, applied };
}

afterEach(() => {
  canvasTheme.set("dark");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
});

describe("createColorTheme", () => {
  it("should follow a light OS setting when nothing is stored", () => {
    const { env, applied } = environment({ media: () => fakeMedia(true).media });
    const theme = createColorTheme(env);

    theme.start();

    expect(theme.state()).toEqual({ choice: "system", theme: "light" });
    expect(applied).toEqual(["light"]);
  });

  it("should follow a dark OS setting, Terminal, when nothing is stored", () => {
    const { env, applied } = environment({ media: () => fakeMedia(false).media });
    const theme = createColorTheme(env);

    theme.start();

    expect(theme.state()).toEqual({ choice: "system", theme: "dark" });
    expect(applied).toEqual(["dark"]);
  });

  it("should open in Terminal when the browser cannot report an OS setting", () => {
    const { env } = environment({ media: () => undefined });
    const theme = createColorTheme(env);

    theme.start();

    expect(theme.state()).toEqual({ choice: "system", theme: "dark" });
  });

  it("should follow a later change of the OS setting when nothing is stored", () => {
    const os = fakeMedia(false);
    const { env, applied } = environment({ media: () => os.media });
    const theme = createColorTheme(env);
    const listener = vi.fn();
    theme.subscribe(listener);
    theme.start();

    os.change(true);

    expect(theme.state().theme).toBe("light");
    expect(applied).toEqual(["dark", "light"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("should keep a stored choice over the OS setting, at start and when the OS setting changes", () => {
    const os = fakeMedia(true);
    const { env, applied } = environment({ media: () => os.media, storage: () => fakeStorage({ [THEME_STORAGE_KEY]: "dark" }) });
    const theme = createColorTheme(env);

    theme.start();
    os.change(false);
    os.change(true);

    expect(theme.state()).toEqual({ choice: "dark", theme: "dark" });
    expect(applied).toEqual(["dark"]);
  });

  it("should store a choice under one key and restore it after a reload", () => {
    const storage = fakeStorage();
    const first = createColorTheme(environment({ storage: () => storage, media: () => fakeMedia(false).media }).env);
    first.start();

    first.choose("light");
    const { env, applied } = environment({ storage: () => storage, media: () => fakeMedia(false).media });
    const reloaded = createColorTheme(env);
    reloaded.start();

    expect(storage.length).toBe(1);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(reloaded.state()).toEqual({ choice: "light", theme: "light" });
    expect(applied).toEqual(["light"]);
  });

  it("should apply a choice at once and tell subscribers when the viewer chooses", () => {
    const { env, applied } = environment();
    const theme = createColorTheme(env);
    theme.start();
    const listener = vi.fn();
    theme.subscribe(listener);

    theme.choose("light");

    expect(theme.state()).toEqual({ choice: "light", theme: "light" });
    expect(applied).toEqual(["dark", "light"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("should forget the stored choice and follow the OS again when the viewer chooses Match system", () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: "dark" });
    const { env } = environment({ storage: () => storage, media: () => fakeMedia(true).media });
    const theme = createColorTheme(env);
    theme.start();

    theme.choose("system");

    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(theme.state()).toEqual({ choice: "system", theme: "light" });
  });

  it("should fall back to the OS setting when the store cannot be read", () => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    const { env } = environment({ storage: blocked, media: () => fakeMedia(true).media });
    const theme = createColorTheme(env);

    theme.start();

    expect(theme.state()).toEqual({ choice: "system", theme: "light" });
  });

  it("should still switch the theme when the store refuses the write", () => {
    const full = fakeStorage();
    full.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
    const { env, applied } = environment({ storage: () => full });
    const theme = createColorTheme(env);
    theme.start();

    theme.choose("light");

    expect(theme.state().theme).toBe("light");
    expect(applied.at(-1)).toBe("light");
  });

  it("should ignore a stored value that is not a theme it knows", () => {
    const { env } = environment({ storage: () => fakeStorage({ [THEME_STORAGE_KEY]: "sepia" }), media: () => fakeMedia(true).media });
    const theme = createColorTheme(env);

    theme.start();

    expect(theme.state()).toEqual({ choice: "system", theme: "light" });
  });

  it("should read the store and the OS setting once however often it is started", () => {
    const storage = vi.fn(() => fakeStorage());
    const { env, applied } = environment({ storage });
    const theme = createColorTheme(env);

    theme.start();
    theme.start();

    expect(storage).toHaveBeenCalledTimes(1);
    expect(applied).toEqual(["dark"]);
  });
});

describe("applyDocumentTheme", () => {
  it("should set data-theme, color-scheme and the theme-color meta to the Light surface when the theme is Light", () => {
    applyDocumentTheme(document, "light");

    const meta = document.querySelector('meta[name="theme-color"]');
    expect([document.documentElement.dataset.theme, document.documentElement.style.colorScheme, meta?.getAttribute("content")]).toEqual([
      "light",
      "light",
      color("surface", "light"),
    ]);
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
  });

  it("should set them back to Terminal's surface when the theme returns to dark", () => {
    applyDocumentTheme(document, "light");
    applyDocumentTheme(document, "dark");

    expect([
      document.documentElement.dataset.theme,
      document.documentElement.style.colorScheme,
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    ]).toEqual(["dark", "dark", "#0b0e14"]);
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
  });
});

describe("colorTheme", () => {
  it("should switch the page and the canvases together when the app's theme changes", () => {
    colorTheme.start();

    colorTheme.choose("light");

    expect([document.documentElement.dataset.theme, canvasTheme.current()]).toEqual(["light", "light"]);
    colorTheme.choose("system");
  });
});
