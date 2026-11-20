// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { hints } from "../domain/hints.ts";
import { regimeFixture } from "../test/fixtures.ts";
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

  it("should show the inputs, the limits and the deciding test in the hint, read with the badge", () => {
    const regime = regimeFixture(300, { trend: "Transition", basis: "Between", adx: 22, efficiencyRatio: 0.25 });
    render(<RegimeBadge regime={regime} timeframeSeconds={300} spec={spec} />);
    const badge = screen.getByText("5m").parentElement;

    act(() => badge?.focus());

    const tip = document.getElementById(badge?.getAttribute("aria-describedby") ?? "");
    expect(tip?.textContent).toContain("ADX 22.00 and the efficiency ratio 0.250 are not both over the trend limits (25, 0.3)");
    expect(tip?.textContent).toContain("under the range limits (20, 0.2)");
    expect(tip?.textContent).toContain("+DI 20.00 · -DI 18.00");
    expect(badge?.tabIndex).toBe(0);
  });
});
