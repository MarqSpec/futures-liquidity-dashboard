// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { positionSchema, type Position } from "../domain/position.ts";
import type { PositionEdit } from "../domain/positionEdit.ts";
import { positionPnl, trackPrint } from "../domain/positionTrack.ts";
import { PositionTicket } from "./PositionTicket.tsx";

// reference: REQUIREMENTS.md FR-72, NFR-8; ARCHITECTURE.md D-58

const spec = { tickSize: 0.25, priceDecimals: 2 };

const long: Position = positionSchema.parse({
  side: "long",
  entryType: "limit",
  entryTicks: 20000,
  quantity: 3,
  stopTicks: 19990,
  targets: [
    { priceTicks: 20010, quantity: 1 },
    { priceTicks: 20020, quantity: 2 },
  ],
  contractId: "MESZ26",
  createdMs: 1760000000000,
});

afterEach(() => {
  cleanup();
});

function renderTicket(position: Position | null, extra: { notice?: string | null; lastTicks?: number | null; note?: string | null; feedback?: { offered: boolean; busy: boolean; onRequest: () => void } } = {}) {
  const onApply = vi.fn<(edit: PositionEdit) => void>();
  const onClear = vi.fn();
  const onPlace = vi.fn();
  const view = render(
    <PositionTicket
      root="MES"
      position={position}
      spec={spec}
      lastTicks={extra.lastTicks === undefined ? 20000 : extra.lastTicks}
      tracking={{ note: extra.note ?? null, pnl: position ? positionPnl(position, 1.25, 20006) : null }}
      notice={extra.notice ?? null}
      onApply={onApply}
      onClear={onClear}
      onPlace={onPlace}
      feedback={extra.feedback}
    />,
  );
  return { ...view, onApply, onClear, onPlace };
}

function applied(onApply: ReturnType<typeof vi.fn<(edit: PositionEdit) => void>>): Position {
  const edit = onApply.mock.calls.at(-1)?.[0];
  if (!edit?.ok) throw new Error(`expected an applied edit, got ${JSON.stringify(edit)}`);
  return edit.position;
}

describe("PositionTicket", () => {
  it("should say SIMULATED and offer to place at the last price when there is no position", async () => {
    const user = userEvent.setup();
    const { onPlace } = renderTicket(null);

    expect(screen.getByRole("region", { name: "Simulated position MES" }).textContent).toContain("SIMULATED");
    expect(screen.getByText(/Alt-click the chart/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Place at last price" }));

    expect(onPlace).toHaveBeenCalledTimes(1);
  });

  it("should disable placing at the last price when there is no last price", () => {
    renderTicket(null, { lastTicks: null });

    expect(screen.getByRole("button", { name: "Place at last price" })).toHaveProperty("disabled", true);
  });

  it("should show the side, type, quantity, entry, stop and each target when a position is set", () => {
    renderTicket(long);

    expect(screen.getByRole("region", { name: "Simulated position MES" }).textContent).toContain("SIMULATED");
    expect(screen.getByLabelText<HTMLSelectElement>("Side").value).toBe("long");
    expect(screen.getByLabelText<HTMLSelectElement>("Type").value).toBe("limit");
    expect(screen.getByLabelText<HTMLInputElement>("Quantity").value).toBe("3");
    expect(screen.getByLabelText<HTMLInputElement>("Entry").value).toBe("5000.00");
    expect(screen.getByLabelText<HTMLInputElement>("Stop").value).toBe("4997.50");
    expect(screen.getByLabelText<HTMLInputElement>("Target 1").value).toBe("5002.50");
    expect(screen.getByLabelText<HTMLInputElement>("Target 1 qty").value).toBe("1");
    expect(screen.getByLabelText<HTMLInputElement>("Target 2").value).toBe("5005.00");
    expect(screen.getByLabelText<HTMLInputElement>("Target 2 qty").value).toBe("2");
  });

  it("should apply a typed stop snapped to the tick when Enter is pressed", async () => {
    const user = userEvent.setup();
    const { onApply } = renderTicket(long);

    await user.clear(screen.getByLabelText("Stop"));
    await user.type(screen.getByLabelText("Stop"), "4996.6{Enter}");

    expect(applied(onApply).stopTicks).toBe(19986);
  });

  it("should spring the field back and pass on the reason when a typed stop breaks FR-72", async () => {
    const user = userEvent.setup();
    const { onApply } = renderTicket(long);
    const stop = screen.getByLabelText<HTMLInputElement>("Stop");

    await user.clear(stop);
    await user.type(stop, "5001{Enter}");

    expect(onApply).toHaveBeenLastCalledWith({ ok: false, reason: "the stop must be below the entry" });
    expect(stop.value).toBe("4997.50");
  });

  it("should refuse a price that is not a number when it is typed", async () => {
    const user = userEvent.setup();
    const { onApply } = renderTicket(long);

    await user.clear(screen.getByLabelText("Target 1"));
    await user.type(screen.getByLabelText("Target 1"), "abc{Enter}");

    expect(onApply).toHaveBeenLastCalledWith({ ok: false, reason: "enter a price" });
  });

  it("should apply a typed field when focus leaves it", async () => {
    const user = userEvent.setup();
    const { onApply } = renderTicket(long);

    await user.clear(screen.getByLabelText("Quantity"));
    await user.type(screen.getByLabelText("Quantity"), "5");
    await user.tab();

    expect(applied(onApply).quantity).toBe(5);
  });

  it("should restore a field without applying it when Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onApply } = renderTicket(long);
    const entry = screen.getByLabelText<HTMLInputElement>("Entry");

    await user.clear(entry);
    await user.type(entry, "4000{Escape}");

    expect(entry.value).toBe("5000.00");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("should switch the side and the entry type from the keyboard", async () => {
    const user = userEvent.setup();
    const { onApply } = renderTicket(long);

    await user.selectOptions(screen.getByLabelText("Side"), "short");
    expect(applied(onApply).side).toBe("short");

    await user.selectOptions(screen.getByLabelText("Type"), "market");
    expect(applied(onApply).entryTicks).toBeNull();
  });

  it("should show a market entry's price as Market and not let it be typed", () => {
    renderTicket({ ...long, entryType: "market", entryTicks: null });

    const entry = screen.getByLabelText<HTMLInputElement>("Entry");
    expect(entry.value).toBe("Market");
    expect(entry.disabled).toBe(true);
  });

  it("should add and remove targets", async () => {
    const user = userEvent.setup();
    const { onApply } = renderTicket({ ...long, quantity: 4 });

    await user.click(screen.getByRole("button", { name: "Add target" }));
    expect(applied(onApply).targets).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Remove target 1" }));
    expect(applied(onApply).targets).toEqual([{ priceTicks: 20020, quantity: 2 }]);
  });

  it("should clear the position", async () => {
    const user = userEvent.setup();
    const { onClear } = renderTicket(long);

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("should reach every field and button in order with Tab", async () => {
    const user = userEvent.setup();
    renderTicket(long);
    const order = [
      screen.getByLabelText("Side"),
      screen.getByLabelText("Type"),
      screen.getByLabelText("Quantity"),
      screen.getByLabelText("Entry"),
      screen.getByLabelText("Stop"),
      screen.getByLabelText("Target 1"),
      screen.getByLabelText("Target 1 qty"),
      screen.getByRole("button", { name: "Remove target 1" }),
      screen.getByLabelText("Target 2"),
      screen.getByLabelText("Target 2 qty"),
      screen.getByRole("button", { name: "Remove target 2" }),
      screen.getByRole("button", { name: "Add target" }),
      screen.getByRole("button", { name: "Clear" }),
    ];

    for (const control of order) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }
  });

  it("should announce the reason a change sprang back when there is a notice", () => {
    renderTicket(long, { notice: "Sprang back: the stop must be below the entry" });

    expect(screen.getByRole("status").textContent).toContain("Sprang back: the stop must be below the entry");
  });

  describe("tracking", () => {
    const working = trackPrint(long, { sourceTimeMs: 4, priceTicks: 20005 });
    const filled = trackPrint(long, { sourceTimeMs: 1_760_000_100_000, priceTicks: 19999 });
    const afterTarget = trackPrint(filled, { sourceTimeMs: 1_760_000_200_000, priceTicks: 20011 });

    it("should say a planned position waits for a live print", () => {
      renderTicket(long);
      expect(screen.getByText(/Planned: waits for the next live print/)).toBeTruthy();
    });

    it("should say what a working limit waits for", () => {
      renderTicket(working);
      expect(screen.getByText("Working: fills on a print below 5000.00")).toBeTruthy();
    });

    it("should show the fill, the exits and the P&L in ticks, currency and R", () => {
      renderTicket(afterTarget);
      expect(screen.getByText(/^Filled ×3 at 5000\.00/)).toBeTruthy();
      expect(screen.getByText("Target ×1 at 5002.50 · +10 ticks · +$12.50 · +0.33 R")).toBeTruthy();
      const pnl = screen.getByLabelText("Simulated P&L").textContent ?? "";
      // Realized: +10 ticks. Open: 2 contracts, +6 ticks each: +12. Risk 30, so total 22 ticks is +0.73 R.
      expect(pnl).toContain("realized +10 ticks · +$12.50 · +0.33 R");
      expect(pnl).toContain("open +12 ticks · +$15.00 · +0.40 R");
      expect(pnl).toContain("total +22 ticks · +$27.50 · +0.73 R");
    });

    it("should show the time not tracked", () => {
      renderTicket(working, { note: "not tracked since 14:02 CT" });
      expect(screen.getByText("not tracked since 14:02 CT")).toBeTruthy();
    });

    it("should show no time-not-tracked note when none was missed", () => {
      const { container } = renderTicket(working);
      expect(container.querySelector(".position-gap")).toBeNull();
    });

    it("should lock the side, type, quantity and entry once the entry has filled", () => {
      renderTicket(filled);
      for (const name of ["Side", "Type", "Quantity", "Entry"]) {
        expect((screen.getByLabelText(name) as HTMLInputElement).disabled).toBe(true);
      }
      expect((screen.getByLabelText("Stop") as HTMLInputElement).disabled).toBe(false);
    });

    it("should leave a working position's entry editable", () => {
      renderTicket(working);
      expect((screen.getByLabelText("Entry") as HTMLInputElement).disabled).toBe(false);
    });
  });
});

// reference: REQUIREMENTS.md FR-74, NFR-8;
describe("PositionTicket Feedback button", () => {
  it("should render no Feedback button when feedback is not offered", () => {
    renderTicket(long, { feedback: { offered: false, busy: false, onRequest: vi.fn() } });
    expect(screen.queryByRole("button", { name: /Feedback|Asking/ })).toBeNull();
  });

  it("should render no Feedback button when the ticket is given no feedback at all", () => {
    renderTicket(long);
    expect(screen.queryByRole("button", { name: /Feedback|Asking/ })).toBeNull();
  });

  it("should render no Feedback button without a position, even when offered", () => {
    renderTicket(null, { feedback: { offered: true, busy: false, onRequest: vi.fn() } });
    expect(screen.queryByRole("button", { name: /Feedback|Asking/ })).toBeNull();
  });

  it("should ask once per press when feedback is offered", async () => {
    const onRequest = vi.fn();
    renderTicket(long, { feedback: { offered: true, busy: false, onRequest } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Feedback" }));
    expect(onRequest).toHaveBeenCalledOnce();
  });

  it("should disable the button while a request is in flight", async () => {
    const onRequest = vi.fn();
    renderTicket(long, { feedback: { offered: true, busy: true, onRequest } });
    const button = screen.getByRole("button", { name: "Asking…" });
    expect(button).toHaveProperty("disabled", true);
    await userEvent.setup().click(button);
    expect(onRequest).not.toHaveBeenCalled();
  });
});
