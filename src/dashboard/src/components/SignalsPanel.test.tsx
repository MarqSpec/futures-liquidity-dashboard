// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Signal } from "../api/schemas.ts";
import type { TickSpec } from "../domain/format.ts";
import { ICEBERG_INFERRED_NOTE, noFloors, type IcebergFloors } from "../domain/signalClusters.ts";
import { SignalsPanel } from "./SignalsPanel.tsx";
import { MEMBER_LIST_LIMIT } from "../domain/signalClusters.ts";
import * as format from "../domain/format.ts";

// reference: REQUIREMENTS.md FR-80, FR-62, FR-9

const spec: TickSpec = { tickSize: 0.25, priceDecimals: 2 };
const T0 = 1_794_000_000_000;
let nextId = 1;

function iceberg(priceTicks: number, timeMs: number, strength: number, hidden: number): Signal {
  return {
    id: nextId++,
    kind: "Iceberg",
    bias: "Bullish",
    timeMs,
    priceTicks,
    priceHighTicks: priceTicks,
    strength,
    label: "Inferred bid iceberg",
    detail: `30 traded against at most 10 shown, 3 refills (avg 5); hidden ≥ ${hidden}. ${ICEBERG_INFERRED_NOTE}`,
    hiddenEstimate: hidden,
  };
}

const stacked: Signal = {
  id: 9_000,
  kind: "StackedImbalance",
  bias: "Bullish",
  timeMs: T0 + 500_000,
  priceTicks: 20_400,
  priceHighTicks: 20_403,
  strength: 0.9,
  label: "Stacked buy imbalance",
  detail: "4 consecutive ticks at 3.5× diagonal",
};

/** Two lone icebergs far apart, and a run of three within 4 ticks and 60 s of each other. */
const lone = [iceberg(20_000, T0, 0.4, 10), iceberg(20_100, T0 + 200_000, 0.9, 50)];
const run = [iceberg(20_200, T0 + 300_000, 0.5, 12), iceberg(20_203, T0 + 330_000, 0.8, 20), iceberg(20_201, T0 + 360_000, 0.3, 8)];
const signals = [...lone, ...run, stacked];

const allOn = () => true;

function Harness({ initial = noFloors, onFloors = vi.fn() }: { initial?: IcebergFloors; onFloors?: (floors: IcebergFloors) => void }) {
  const [floors, setFloors] = useState(initial);
  return (
    <SignalsPanel
      signals={signals}
      spec={spec}
      isKindOn={allOn}
      onToggleKind={vi.fn()}
      floors={floors}
      onFloors={(next) => {
        setFloors(next);
        onFloors(next);
      }}
    />
  );
}

function rows(): HTMLElement[] {
  const list = screen.getByRole("list", { name: "Signals, newest first" });
  return within(list).getAllByRole("listitem").filter((item) => item.parentElement === list);
}

afterEach(cleanup);

describe("SignalsPanel", () => {
  it("should say once, not on every row, that icebergs are inferred when several are listed", () => {
    render(<Harness />);

    expect(screen.getAllByText(/inferred from prints and book changes, not exchange order ids/i)).toHaveLength(1);
    for (const row of rows()) expect(row.textContent).not.toContain(ICEBERG_INFERRED_NOTE);
  });

  it("should keep the inferred label on every iceberg row when the note is shown once", () => {
    render(<Harness />);

    const icebergRows = rows().filter((row) => row.textContent?.includes("Iceberg (inferred)"));
    expect(icebergRows).toHaveLength(3);
    for (const row of icebergRows) expect(row.textContent).toContain("Inferred bid iceberg");
  });

  it("should not show the iceberg note when the iceberg kind is off", () => {
    render(<SignalsPanel signals={signals} spec={spec} isKindOn={(kind) => kind !== "Iceberg"} onToggleKind={vi.fn()} floors={noFloors} />);

    expect(screen.queryByText(/not exchange order ids/i)).toBeNull();
  });

  it("should fold neighbouring icebergs into one row with their range, count, summed hidden size and strongest member", () => {
    render(<Harness />);

    const cluster = rows().find((row) => row.textContent?.includes("×3"));
    expect(cluster?.textContent).toContain("Inferred bid iceberg ×3 @ 5050.00 – 5050.75");
    expect(cluster?.textContent).toContain("hidden ≥ 40 summed");
    expect(cluster?.textContent).toContain("strongest 80 % @ 5050.75");
    expect(rows()).toHaveLength(4);
  });

  it("should list a cluster's members when the cluster row is expanded", async () => {
    render(<Harness />);
    const cluster = rows().find((row) => row.textContent?.includes("×3"));
    if (!cluster) throw new Error("no cluster row");

    await userEvent.click(within(cluster).getByText("Show 3 icebergs"));

    const details = cluster.querySelector("details");
    expect(details?.open).toBe(true);
    const members = within(within(cluster).getByRole("list", { name: "Icebergs in this cluster" })).getAllByRole("listitem");
    expect(members.map((member) => member.textContent?.match(/hidden ≥ \d+/)?.[0])).toEqual(["hidden ≥ 8", "hidden ≥ 20", "hidden ≥ 12"]);
  });

  it("should say how many icebergs the floors hide beside the kind's count", () => {
    render(<Harness initial={{ minStrengthPercent: 45, minHiddenSize: 0 }} />);

    const toggle = screen.getByRole("checkbox", { name: /Iceberg \(inferred\)/ }).closest("label");
    expect(toggle?.textContent).toContain("5");
    expect(toggle?.textContent).toContain("2 below floors");
    expect(screen.getByRole("checkbox", { name: /Stacked imbalance/ }).closest("label")?.textContent).not.toContain("below floors");
  });

  it("should hide the icebergs below a strength floor the viewer types, and save it", async () => {
    const onFloors = vi.fn();
    render(<Harness onFloors={onFloors} />);
    const strength = screen.getByRole("spinbutton", { name: "Minimum iceberg strength (%)" });

    await userEvent.clear(strength);
    await userEvent.type(strength, "85");

    expect(onFloors).toHaveBeenLastCalledWith({ minStrengthPercent: 85, minHiddenSize: 0 });
    expect(rows().map((row) => row.textContent?.includes("Iceberg (inferred)"))).toEqual([false, true]);
  });

  it("should hide the icebergs whose hidden lower bound is below a size floor the viewer types", async () => {
    const onFloors = vi.fn();
    render(<Harness onFloors={onFloors} />);
    const size = screen.getByRole("spinbutton", { name: "Minimum iceberg hidden size" });

    await userEvent.clear(size);
    await userEvent.type(size, "15");

    expect(onFloors).toHaveBeenLastCalledWith({ minStrengthPercent: 0, minHiddenSize: 15 });
    expect(screen.getByRole("checkbox", { name: /Iceberg \(inferred\)/ }).closest("label")?.textContent).toContain("3 below floors");
  });

  it("should drop the iceberg rows when the iceberg toggle turns off on a later render", () => {
    const { rerender } = render(<SignalsPanel signals={signals} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);
    expect(rows()).toHaveLength(4);

    rerender(<SignalsPanel signals={signals} spec={spec} isKindOn={(kind) => kind !== "Iceberg"} onToggleKind={vi.fn()} floors={{ ...noFloors }} />);

    expect(rows()).toHaveLength(1);
  });

  it("should list a kind the server added later, which no toggle can hide", () => {
    const later: Signal = { ...stacked, id: 9_001, kind: "SomethingNew", label: "A later kind" };

    render(<SignalsPanel signals={[later]} spec={spec} isKindOn={(kind) => kind !== "Iceberg"} onToggleKind={vi.fn()} floors={noFloors} />);

    expect(rows().map((row) => row.textContent?.includes("A later kind"))).toEqual([true]);
  });

  it("should show the floors without an editor when no saver is given", () => {
    render(<SignalsPanel signals={signals} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={{ minStrengthPercent: 30, minHiddenSize: 5 }} />);

    expect((screen.getByRole("spinbutton", { name: "Minimum iceberg strength (%)" }) as HTMLInputElement).disabled).toBe(true);
  });

  // (REQUIREMENTS.md FR-83)
  it("should tag and dim a signal raised on a thin tape, and leave the others untagged", () => {
    const thin = { ...stacked, id: 9_001, timeMs: T0 + 600_000, thinTape: true };
    render(<SignalsPanel signals={[stacked, thin]} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);

    const [newest, older] = rows();
    expect(newest?.className).toContain("ld-signal--thin");
    expect(within(newest as HTMLElement).getByText("thin tape").getAttribute("title")).toMatch(/trade rate was under its share of its own recent median/);
    expect(older?.className).not.toContain("ld-signal--thin");
    expect(older?.textContent).not.toContain("thin tape");
  });

  // (REQUIREMENTS.md FR-83)
  it("should say how many of a cluster's icebergs were raised on a thin tape when some were", () => {
    const thinRun = run.map((signal, i) => ({ ...signal, thinTape: i < 2 }));
    render(<SignalsPanel signals={thinRun} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);

    const cluster = rows().find((row) => row.textContent?.includes("×3"));
    expect(cluster?.textContent).toContain("2 on a thin tape");
  });
});

// reference: REQUIREMENTS.md FR-82; ARCHITECTURE.md D-69
describe("SignalsPanel groups", () => {
  const sweepAt: Signal = {
    id: 9_100,
    kind: "LiquiditySweep",
    bias: "Bearish",
    timeMs: T0 + 1_000_000,
    priceTicks: 20_600,
    priceHighTicks: 20_602,
    strength: 0.72,
    label: "Offer sweep (inferred)",
    detail: "3 levels taken in 200 ms",
  };
  const stackedNear: Signal = { ...stacked, id: 9_101, timeMs: T0 + 1_060_000, priceTicks: 20_601, priceHighTicks: 20_604, strength: 0.55 };
  const icebergsNear = [iceberg(20_605, T0 + 1_100_000, 0.4, 10), iceberg(20_606, T0 + 1_120_000, 0.61, 6)];
  const together = [sweepAt, stackedNear, ...icebergsNear];

  function groupRow(): HTMLElement {
    const row = rows().find((item) => item.classList.contains("ld-signal--group"));
    if (!row) throw new Error("no group row");
    return row;
  }

  function summary(row: HTMLElement): string {
    return row.querySelector(".detail")?.textContent ?? "";
  }

  it("should show signals of several kinds within 6 ticks and 5 minutes as one row naming the kinds, the range and the span", () => {
    render(<SignalsPanel signals={together} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);

    expect(rows()).toHaveLength(1);
    const row = groupRow();
    expect(summary(row)).toContain("Liquidity sweep (inferred) 72 %");
    expect(summary(row)).toContain("Stacked imbalance 55 %");
    expect(summary(row)).toContain("Iceberg (inferred) ×2, strongest 61 %");
    expect(summary(row)).toContain("@ 5150.00 – 5151.50");
    expect(summary(row)).toContain("4 signals");
    expect(row.querySelector(".when")?.textContent).toMatch(/^\d\d:\d\d:\d\d – \d\d:\d\d:\d\d$/);
  });

  // (REQUIREMENTS.md FR-83)
  it("should say how many of a group's signals were raised on a thin tape, counting inside a cluster, and say nothing when none were", () => {
    const thinSome = [{ ...sweepAt, thinTape: true }, stackedNear, { ...icebergsNear[0], thinTape: true } as Signal, icebergsNear[1] as Signal];
    render(<SignalsPanel signals={thinSome} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);
    const withThin = summary(groupRow());
    cleanup();
    render(<SignalsPanel signals={together} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);

    expect(withThin).toContain("· 2 on a thin tape");
    expect(summary(groupRow())).not.toContain("thin tape");
  });

  it("should give the group no direction of its own", () => {
    render(<SignalsPanel signals={together} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);

    const header = groupRow().querySelector(":scope > .kind")?.textContent ?? "";
    expect(`${header} ${summary(groupRow())}`).not.toMatch(/bullish|bearish|neutral|buy|sell/i);
    expect(groupRow().className).not.toMatch(/ld-signal--(bullish|bearish|neutral)/);
  });

  it("should list each member with its own strength when the group is expanded", async () => {
    render(<SignalsPanel signals={together} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);

    await userEvent.click(within(groupRow()).getByText("Show 4 signals"));

    const members = within(groupRow()).getByRole("list", { name: "Signals in this group" });
    const memberRows = within(members).getAllByRole("listitem").filter((item) => item.parentElement === members);
    expect(memberRows.map((item) => item.textContent?.match(/strongest \d+ %|strength \d+ %/)?.[0])).toEqual([
      "strongest 61 %",
      "strength 55 %",
      "strength 72 %",
    ]);
  });

  it("should hide a kind's members when its toggle turns off, and drop the group when one kind is left", () => {
    const { rerender } = render(<SignalsPanel signals={together} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);

    rerender(<SignalsPanel signals={together} spec={spec} isKindOn={(kind) => kind !== "Iceberg"} onToggleKind={vi.fn()} floors={noFloors} />);
    expect(summary(groupRow())).not.toContain("Iceberg");
    expect(summary(groupRow())).toContain("2 signals");

    rerender(<SignalsPanel signals={together} spec={spec} isKindOn={(kind) => kind === "LiquiditySweep"} onToggleKind={vi.fn()} floors={noFloors} />);
    expect(rows().some((row) => row.classList.contains("ld-signal--group"))).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it("should send the group's range while the pointer is over its row, and clear it when the pointer leaves", async () => {
    const onHoverGroup = vi.fn();
    render(<SignalsPanel signals={together} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} onHoverGroup={onHoverGroup} />);

    await userEvent.hover(groupRow());
    expect(onHoverGroup).toHaveBeenLastCalledWith({ key: `group-${sweepAt.id}`, lowTicks: 20_600, highTicks: 20_606 });

    await userEvent.unhover(groupRow());
    expect(onHoverGroup).toHaveBeenLastCalledWith(null);
  });

  it("should select the group for the chart with its mark button, and clear it with a second press", async () => {
    const onSelectGroup = vi.fn();
    function Selecting() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <SignalsPanel
          signals={together}
          spec={spec}
          isKindOn={allOn}
          onToggleKind={vi.fn()}
          floors={noFloors}
          selectedGroup={selected}
          onSelectGroup={(mark) => {
            setSelected(mark?.key ?? null);
            onSelectGroup(mark);
          }}
        />
      );
    }
    render(<Selecting />);
    const mark = within(groupRow()).getByRole("button", { name: "Mark on chart" });

    await userEvent.click(mark);
    expect(onSelectGroup).toHaveBeenLastCalledWith({ key: `group-${sweepAt.id}`, lowTicks: 20_600, highTicks: 20_606 });
    expect(mark.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(mark);
    expect(onSelectGroup).toHaveBeenLastCalledWith(null);
    expect(mark.getAttribute("aria-pressed")).toBe("false");
  });

  it("should offer no mark button when nothing listens for a selection", () => {
    render(<SignalsPanel signals={together} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);

    expect(within(groupRow()).queryByRole("button", { name: "Mark on chart" })).toBeNull();
  });
});

// (REQUIREMENTS.md FR-80, FR-82)
describe("SignalsPanel members load on open", () => {
  const bigRun = Array.from({ length: MEMBER_LIST_LIMIT + 7 }, (_, i) => iceberg(30_000 + (i % 3), T0 + i * 1_000, 0.5, 10 + i));
  const sweep: Signal = { id: 9_900, kind: "LiquiditySweep", bias: "Bearish", timeMs: T0, priceTicks: 30_000, priceHighTicks: 30_001, strength: 0.7, label: "Offer sweep (inferred)", detail: "x" };
  const panel = (list: readonly Signal[]) => <SignalsPanel signals={list} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />;

  it("should render no member rows while a cluster is closed", () => {
    render(panel(bigRun));

    expect(screen.queryByRole("list", { name: "Icebergs in this cluster" })).toBeNull();
    expect(document.querySelectorAll("li")).toHaveLength(1);
  });

  it("should render no member rows while a group is closed", () => {
    render(panel([sweep, ...bigRun]));

    expect(screen.queryByRole("list", { name: "Signals in this group" })).toBeNull();
    expect(document.querySelectorAll("li")).toHaveLength(1);
  });

  it("should cap an opened cluster's members and say how many more there are, then unmount them when closed", async () => {
    render(panel(bigRun));
    const summaryEl = screen.getByText(`Show ${bigRun.length} icebergs`);

    await userEvent.click(summaryEl);
    const list = screen.getByRole("list", { name: "Icebergs in this cluster" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(MEMBER_LIST_LIMIT + 1);
    expect(within(list).getByText("+7 more")).toBeTruthy();

    await userEvent.click(summaryEl);
    expect(screen.queryByRole("list", { name: "Icebergs in this cluster" })).toBeNull();
  });

  it("should cap an opened group's member rows and say how many more rows there are", async () => {
    // Sweeps and one stacked imbalance on one tick range: two kinds, so one group, and every sweep is a row of its own.
    const sweeps = Array.from({ length: MEMBER_LIST_LIMIT + 5 }, (_, i): Signal => ({ ...sweep, id: 8_000 + i, timeMs: T0 + i * 1_000 }));
    render(panel([...sweeps, { ...stacked, timeMs: T0 + 100_000, priceTicks: 30_000, priceHighTicks: 30_002 }]));

    await userEvent.click(screen.getByText(`Show ${sweeps.length + 1} signals`));

    const list = screen.getByRole("list", { name: "Signals in this group" });
    expect(Array.from(list.children).filter((li) => li.tagName === "LI")).toHaveLength(MEMBER_LIST_LIMIT + 1);
    expect(within(list).getByText("+6 more rows")).toBeTruthy();
  });

  it("should keep the native summary of a row as its first child, with no role or tab stop of its own", () => {
    render(panel(bigRun));

    const summaryEl = screen.getByText(`Show ${bigRun.length} icebergs`);
    expect(summaryEl.tagName).toBe("SUMMARY");
    expect(summaryEl.parentElement?.tagName).toBe("DETAILS");
    expect(summaryEl.parentElement?.firstElementChild).toBe(summaryEl);
    expect(summaryEl.hasAttribute("tabindex")).toBe(false);
    expect(summaryEl.hasAttribute("role")).toBe(false);
  });

  it("should not re-render a row when only another row's data changes", () => {
    const a = iceberg(20_000, T0, 0.4, 10);
    const b = iceberg(21_000, T0 + 1_000_000, 0.9, 50);
    const rowsOf = (second: Signal) => [{ type: "single", signal: second } as const, { type: "single", signal: a } as const];
    const spy = vi.spyOn(format, "formatLocalTime");
    const { rerender } = render(<SignalsPanel signals={[a, b]} rows={rowsOf(b)} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);
    spy.mockClear();

    rerender(<SignalsPanel signals={[a, b]} rows={rowsOf({ ...b, strength: 0.5 })} spec={spec} isKindOn={allOn} onToggleKind={vi.fn()} floors={noFloors} />);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
