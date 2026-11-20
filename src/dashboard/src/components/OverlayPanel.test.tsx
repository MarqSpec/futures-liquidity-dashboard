// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { LevelTouch } from "../api/schemas.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { OverlayPanel } from "./OverlayPanel.tsx";

// The Levels panel lists the open product's own touch counts and how they ended.
// (REQUIREMENTS.md FR-79)

const spec = { tickSize: 0.25, priceDecimals: 2 };
const touches: LevelTouch[] = [
  { name: "PDL", priceTicks: 27_000, isHigh: false, touches: 0, lastTouchMs: null, isThirdTouch: false, held: 0, broke: 0 },
  { name: "PDH", priceTicks: 27_400, isHigh: true, touches: 3, lastTouchMs: 5, isThirdTouch: true, held: 2, broke: 1 },
];

afterEach(() => {
  cleanup();
});

describe("OverlayPanel touches", () => {
  it("should list each level's touches and outcome, highest price first, when the product has levels", () => {
    render(<OverlayPanel overlay={null} spec={spec} shown touches={touches} />);

    const rows = within(screen.getByRole("list", { name: "Level touches" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["PDH6850.003rd touch · 2 held · 1 broke", "PDL6750.00no touch yet"]);
  });

  it("should list the product's touches above the overlay when an overlay is published", () => {
    render(<OverlayPanel overlay={snapshotFixture().overlay ?? null} spec={spec} shown touches={touches} />);

    expect(within(screen.getByRole("list", { name: "Level touches" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("should say the product has no levels yet when none are listed", () => {
    render(<OverlayPanel overlay={null} spec={spec} shown touches={[]} />);

    expect(screen.getByText("No levels for this product yet.")).toBeTruthy();
  });
});
