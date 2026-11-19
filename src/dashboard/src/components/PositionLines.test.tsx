// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { positionSchema, type Position } from "../domain/position.ts";
import type { PositionEdit } from "../domain/positionEdit.ts";
import { trackPrint } from "../domain/positionTrack.ts";
import { PositionLines, type PositionFrame } from "./PositionLines.tsx";

// reference: REQUIREMENTS.md FR-72; ARCHITECTURE.md D-58

const spec = { tickSize: 0.25, priceDecimals: 2 };
// 200 ticks over 400 px: 2 px a tick, 20100 at the top.
const frame: PositionFrame = { left: 0, right: 600, top: 0, bottom: 400, axisWidth: 60, lowTicks: 19900, highTicks: 20100 };

const long: Position = positionSchema.parse({
  side: "long",
  entryType: "limit",
  entryTicks: 20000,
  quantity: 3,
  stopTicks: 19990,
  targets: [{ priceTicks: 20010, quantity: 1 }],
  contractId: "MESZ26",
  createdMs: 1760000000000,
});

afterEach(() => {
  cleanup();
});

function renderLines(position: Position | null, notice: string | null = null, shown: PositionFrame = frame) {
  const onApply = vi.fn<(edit: PositionEdit) => void>();
  const parentDown = vi.fn();
  const view = render(
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div onPointerDown={parentDown} onPointerMove={parentDown}>
      <PositionLines position={position} spec={spec} frame={shown} notice={notice} onApply={onApply} />
    </div>,
  );
  return { ...view, onApply, parentDown };
}

function lineOf(label: string): HTMLElement {
  const line = screen.getByText(label).closest<HTMLElement>("[data-position-line]");
  if (!line) throw new Error(`no line labelled ${label}`);
  return line;
}

function drag(line: HTMLElement, fromY: number, toY: number) {
  fireEvent.pointerDown(line, { button: 0, clientX: 100, clientY: fromY, pointerId: 4 });
  fireEvent.pointerMove(line, { clientX: 100, clientY: toY, pointerId: 4 });
  fireEvent.pointerUp(line, { clientX: 100, clientY: toY, pointerId: 4 });
}

describe("PositionLines", () => {
  it("should draw the entry, stop and target at their prices, each labelled SIMULATED with a price tag", () => {
    renderLines(long);

    expect(lineOf("SIMULATED long entry ×3").style.top).toBe("200px");
    expect(lineOf("SIMULATED stop").style.top).toBe("220px");
    expect(lineOf("SIMULATED target 1 ×1").style.top).toBe("180px");
    expect(lineOf("SIMULATED stop").textContent).toContain("4997.50");
  });

  it("should draw nothing when there is no position", () => {
    const { container } = renderLines(null);

    expect(container.textContent).not.toContain("SIMULATED");
  });

  it("should mark a line whose price is off the visible range at the plot's edge instead of drawing it", () => {
    renderLines({ ...long, targets: [{ priceTicks: 20200, quantity: 1 }], stopTicks: 19800 });

    expect(screen.queryByText("SIMULATED target 1 ×1")).toBeNull();
    expect(screen.getByText("▲ SIMULATED target 1 ×1 5050.00").style.top).toBe("0px");
    expect(screen.getByText("▼ SIMULATED stop 4950.00").style.top).toBe("384px");
    expect(document.querySelector("[data-position-line='stop']")).toBeNull();
  });

  it("should move the stop on the tick grid when it is dragged and dropped", () => {
    const { onApply } = renderLines(long);

    drag(lineOf("SIMULATED stop"), 220, 243.3);

    // 23.3 px down is 11.65 ticks lower, which snaps to 12.
    expect(onApply).toHaveBeenCalledTimes(1);
    const edit = onApply.mock.calls[0]?.[0];
    expect(edit?.ok && edit.position.stopTicks).toBe(19978);
  });

  it("should follow the pointer while the line is dragged", () => {
    renderLines(long);
    const stop = lineOf("SIMULATED stop");

    fireEvent.pointerDown(stop, { button: 0, clientX: 100, clientY: 220, pointerId: 4 });
    fireEvent.pointerMove(stop, { clientX: 100, clientY: 240, pointerId: 4 });

    expect(stop.style.top).toBe("240px");
    expect(stop.textContent).toContain("4995.00");
  });

  it("should spring back and pass on the refusal when the drop breaks FR-72", () => {
    const { onApply } = renderLines(long);
    const stop = lineOf("SIMULATED stop");

    // 30 px up puts a long's stop 5 ticks above its entry.
    drag(stop, 220, 190);

    expect(onApply).toHaveBeenCalledWith({ ok: false, reason: "the stop must be below the entry" });
    expect(stop.style.top).toBe("220px");
    expect(stop.textContent).toContain("4997.50");
  });

  it("should not apply anything when a line is pressed and released in place", () => {
    const { onApply } = renderLines(long);

    drag(lineOf("SIMULATED stop"), 220, 220.4);

    expect(onApply).not.toHaveBeenCalled();
  });

  it("should keep a press on a line from reaching the chart, so it does not start a pan", () => {
    const { parentDown } = renderLines(long);

    drag(lineOf("SIMULATED stop"), 220, 230);

    expect(parentDown).not.toHaveBeenCalled();
  });

  it("should show the reason a drop sprang back when there is a notice", () => {
    renderLines(long, "Sprang back: the stop must be below the entry");

    expect(screen.getByText("Sprang back: the stop must be below the entry")).toBeTruthy();
  });
});

describe("PositionLines tracking", () => {
  it("should mark a filled entry and a filled target as done", () => {
    const filled = trackPrint(long, { sourceTimeMs: 5, priceTicks: 19999 });
    const afterTarget = trackPrint(filled, { sourceTimeMs: 6, priceTicks: 20011 });
    renderLines(afterTarget);

    expect(lineOf("SIMULATED long entry ×3 · filled").className).toContain("position-line-done");
    expect(lineOf("SIMULATED target 1 ×1 · filled").className).toContain("position-line-done");
    expect(lineOf("SIMULATED stop").className).not.toContain("position-line-done");
  });

  it("should draw a market entry's fill where it filled, and let no press land on it", () => {
    const market = positionSchema.parse({ ...long, entryType: "market", entryTicks: null });
    const filled = trackPrint(market, { sourceTimeMs: 5, priceTicks: 20004 });
    const { onApply } = renderLines(filled);

    const fill = lineOf("SIMULATED long filled ×3");
    expect(fill.style.top).toBe("192px");
    expect(fill.className).toContain("position-line-fixed");
    expect(lineOf("SIMULATED stop").className).not.toContain("position-line-fixed");
    drag(fill, 192, 150);
    expect(onApply).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("should spring a stop drag back once the position is closed", () => {
    const filled = trackPrint(long, { sourceTimeMs: 5, priceTicks: 19999 });
    const closed = trackPrint(filled, { sourceTimeMs: 6, priceTicks: 19980 });
    const { onApply } = renderLines(closed);

    drag(lineOf("SIMULATED stop · hit"), 420, 380);
    expect(onApply).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});

// reference: REQUIREMENTS.md FR-74;
describe("PositionLines feedback ghosts", () => {
  const ghosts = [{ key: "ghost-stop", line: { kind: "stop" } as const, priceTicks: 19994, label: "Suggested stop 4998.50" }];

  function renderGhosts(shown: typeof ghosts, onApplyGhost = vi.fn()) {
    const parentDown = vi.fn();
    render(
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onPointerDown={parentDown}>
        <PositionLines position={long} spec={spec} frame={frame} notice={null} onApply={vi.fn()} ghosts={shown} onApplyGhost={onApplyGhost} />
      </div>,
    );
    return { onApplyGhost, parentDown };
  }

  it("should draw a ghost line at the suggestion's price with its label", () => {
    renderGhosts(ghosts);
    const ghost = document.querySelector<HTMLElement>('[data-position-ghost="ghost-stop"]');
    expect(ghost?.style.top).toBe("212px");
    expect(ghost?.textContent).toContain("Suggested stop 4998.50 · click to apply");
  });

  it("should apply the suggestion on one click", () => {
    const { onApplyGhost } = renderGhosts(ghosts);
    fireEvent.click(document.querySelector('[data-position-ghost="ghost-stop"]') as HTMLElement);
    expect(onApplyGhost).toHaveBeenCalledExactlyOnceWith(ghosts[0]);
  });

  it("should not let the press reach the chart beneath", () => {
    const { parentDown } = renderGhosts(ghosts);
    fireEvent.pointerDown(document.querySelector('[data-position-ghost="ghost-stop"]') as HTMLElement);
    expect(parentDown).not.toHaveBeenCalled();
  });

  it("should draw no ghost for a suggestion outside the visible range", () => {
    renderGhosts([{ ...ghosts[0]!, priceTicks: 30000 }]);
    expect(document.querySelector("[data-position-ghost]")).toBeNull();
  });

  it("should draw no ghost when there are none", () => {
    renderGhosts([]);
    expect(document.querySelector("[data-position-ghost]")).toBeNull();
  });
});
