// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import mainChart from "../components/MainChart.tsx?raw";
import profilePanel from "../components/ProfilePanel.tsx?raw";
import timePane from "../components/TimePane.tsx?raw";
import bookmapView from "../components/BookmapView.tsx?raw";
import { canvasTheme } from "../theme.ts";
import { useCanvasTheme } from "./useCanvasTheme.ts";

// A canvas component re-renders, and so redraws, when the theme changes.

afterEach(() => {
  act(() => canvasTheme.set("dark"));
});

describe("useCanvasTheme", () => {
  it("should re-render with the new theme when the canvas theme changes", () => {
    const { result } = renderHook(() => useCanvasTheme());
    expect(result.current).toBe("dark");

    act(() => canvasTheme.set("light"));

    expect(result.current).toBe("light");
  });

  it.each([
    ["MainChart.tsx", mainChart],
    ["TimePane.tsx", timePane],
    ["ProfilePanel.tsx", profilePanel],
    ["BookmapView.tsx", bookmapView],
  ])("should be read by %s, so that canvas repaints on a theme change", (_file, source) => {
    expect(source).toContain("prepareSurface(");
    // A statement of its own on a line, so a commented-out call does not count.
    expect(source).toMatch(/^ {2}(?:const theme = )?useCanvasTheme\(\);$/m);
  });
});
