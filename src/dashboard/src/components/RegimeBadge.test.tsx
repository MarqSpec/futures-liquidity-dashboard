// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { hints } from "../domain/hints.ts";
import { RegimeBadge } from "./RegimeBadge.tsx";


afterEach(cleanup);

const spec = { tickSize: 0.25, priceDecimals: 2 };

describe("RegimeBadge", () => {
  it("should explain the 5m and 15m labels on keyboard focus and describe the control by the hint", () => {
    render(
      <>
        <RegimeBadge regime={null} timeframeSeconds={300} spec={spec} />
        <RegimeBadge regime={null} timeframeSeconds={900} spec={spec} />
      </>,
    );
    const [five, fifteen] = [screen.getByText("5m").parentElement, screen.getByText("15m").parentElement];

    act(() => five?.focus());
    expect(screen.getByRole("tooltip").textContent).toContain(hints.regime5m);
    act(() => five?.blur());
    act(() => fifteen?.focus());

    expect(screen.getByRole("tooltip").textContent).toContain(hints.regime15m);
    expect(document.getElementById(fifteen?.getAttribute("aria-describedby") ?? "")?.textContent).toContain(hints.regime15m);
    expect(fifteen?.hasAttribute("title")).toBe(false);
  });
});
