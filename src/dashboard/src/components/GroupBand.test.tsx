// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { TickSpec } from "../domain/format.ts";
import { GroupBand } from "./GroupBand.tsx";
import type { PositionFrame } from "./PositionLines.tsx";

// reference: REQUIREMENTS.md FR-82; ARCHITECTURE.md D-69

const spec: TickSpec = { tickSize: 0.25, priceDecimals: 2 };
/** 20 ticks over 200 px: 10 px a tick. */
const frame: PositionFrame = { left: 10, right: 410, top: 0, bottom: 200, axisWidth: 60, lowTicks: 100, highTicks: 120 };

afterEach(cleanup);

function band(): HTMLElement | null {
  return document.querySelector(".group-band");
}

describe("GroupBand", () => {
  it("should shade the group's price range, half a tick beyond each end, across the plot", () => {
    render(<GroupBand mark={{ key: "group-1", lowTicks: 104, highTicks: 106 }} frame={frame} spec={spec} />);

    expect(band()?.style.top).toBe("135px");
    expect(band()?.style.height).toBe("30px");
    expect(band()?.style.left).toBe("10px");
    expect(band()?.style.width).toBe("400px");
    expect(document.querySelector(".group-band-label")?.textContent).toBe("Group 26.00 – 26.50");
  });

  it("should draw nothing when no group is marked", () => {
    const { container } = render(<GroupBand mark={null} frame={frame} spec={spec} />);

    expect(container.innerHTML).toBe("");
  });

  it("should clip a range that runs past the top of the plot to the plot", () => {
    render(<GroupBand mark={{ key: "group-1", lowTicks: 118, highTicks: 125 }} frame={frame} spec={spec} />);

    expect(band()?.style.top).toBe("0px");
    expect(band()?.style.height).toBe("25px");
  });

  it("should say the group is above the view, without a band, when its whole range is above it", () => {
    render(<GroupBand mark={{ key: "group-1", lowTicks: 130, highTicks: 131 }} frame={frame} spec={spec} />);

    expect(band()).toBeNull();
    expect(document.querySelector(".group-band-label")?.textContent).toBe("Group 32.50 – 32.75 above the view");
  });

  it("should say the group is below the view, without a band, when its whole range is below it", () => {
    render(<GroupBand mark={{ key: "group-1", lowTicks: 90, highTicks: 92 }} frame={frame} spec={spec} />);

    expect(band()).toBeNull();
    expect(document.querySelector(".group-band-label")?.textContent).toBe("Group 22.50 – 23.00 below the view");
  });
});
