// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Signal } from "../api/schemas.ts";
import type { TickSpec } from "../domain/format.ts";
import { ICEBERG_INFERRED_NOTE, noFloors, type IcebergFloors } from "../domain/signalClusters.ts";
import { SignalsPanel } from "./SignalsPanel.tsx";

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
});
