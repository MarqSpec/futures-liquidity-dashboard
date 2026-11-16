// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstrumentSummary } from "../api/schemas.ts";
import { watchlistLimit } from "../domain/layout.ts";
import { instrumentSummaryFixture, instrumentsFixture } from "../test/fixtures.ts";
import { OverviewTable } from "./OverviewTable.tsx";

// The Overview's design-system markup: a counted heading with feed-status chips, the sort indicator, the change
// glyph, the agreement word, the watchlist star and the open product's row, with sorting, filtering and opening
// behaving as before.

afterEach(cleanup);

const noop = () => undefined;

/** Three LIVE products (rising, falling, flat) in Equity index, and one REPLAY product in Metals with no price. */
function products(): InstrumentSummary[] {
  const make = (root: string, sector: string, code: string, last: number | null, open: number | null) =>
    instrumentSummaryFixture({ root, name: `${root} name`, sector }, { last, sessionOpen: open }, { code });
  return [
    make("UP", "Equity index", "LIVE", 104, 100),
    make("DN", "Equity index", "LIVE", 96, 100),
    make("FL", "Equity index", "LIVE", 100, 100),
    make("NA", "Metals", "REPLAY", null, null),
  ];
}

interface Options {
  readonly summaries?: readonly InstrumentSummary[];
  readonly watchlist?: readonly string[];
  readonly refused?: readonly string[];
  readonly onOpen?: (root: string) => void;
  readonly onWatch?: (root: string, on: boolean) => void;
}

function renderOverview({ summaries = products(), watchlist = ["NA"], refused = [], onOpen = noop, onWatch = noop }: Options = {}) {
  return render(<OverviewTable summaries={summaries} watchlist={watchlist} active="UP" refused={refused} onOpen={onOpen} onWatch={onWatch} />);
}

function header(name: string): HTMLElement {
  return screen.getByRole("columnheader", { name: new RegExp(`^${name}`) });
}

function rowOf(container: HTMLElement, root: string): HTMLElement {
  const row = container.querySelector(`button[aria-label^="Open ${root} in Detail"]`)?.closest("tr");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${root}`);
  return row;
}

describe("OverviewTable design", () => {
  it("should head the table All products with the shown and total counts", () => {
    renderOverview();

    expect(screen.getByRole("heading", { name: "All products (4 of 4)" })).toBeTruthy();
  });

  it("should list each feed status with its exact count and no chip for a state no product is in", () => {
    renderOverview();

    const items = within(screen.getByRole("list", { name: "Feed status across products" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["LIVE 3", "REPLAY 1"]);
  });

  it("should draw the sort arrow on the sorted column only, and flip it on a second press", () => {
    renderOverview();

    fireEvent.click(within(header("Last")).getByRole("button"));
    const ascending = [header("Last").getAttribute("aria-sort"), header("Last").textContent, header("Vol").getAttribute("aria-sort")];
    fireEvent.click(within(header("Last")).getByRole("button"));

    expect([ascending, header("Last").getAttribute("aria-sort"), header("Last").textContent]).toEqual([
      ["ascending", "Last ▲", "none"],
      "descending",
      "Last ▼",
    ]);
  });

  it("should show a rising change with ▲, a falling one with ▼ and a flat or unknown one with neither", () => {
    const { container } = renderOverview();

    const glyphs = ["UP", "DN", "FL", "NA"].map((root) => {
      const text = within(rowOf(container, root)).getAllByRole("cell")[3]?.textContent ?? "";
      return [text.includes("▲"), text.includes("▼")];
    });
    expect(glyphs).toEqual([
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ]);
  });

  it("should show agreement as a word in its own tone class", () => {
    const { container } = render(
      <OverviewTable summaries={instrumentsFixture()} watchlist={[]} active="ES" refused={[]} onOpen={noop} onWatch={noop} />,
    );

    const words = [...container.querySelectorAll("td.agreement")].map((cell) => [cell.textContent, cell.className]);
    expect(words).toContainEqual(["Agree", "agreement agreement-agree"]);
    expect(words).toContainEqual(["Conflict", "agreement agreement-conflict"]);
    expect(words).toContainEqual(["Mixed", "agreement agreement-mixed"]);
  });

  it("should put each group's own product count in its heading", () => {
    const { container } = renderOverview();

    const headings = [...container.querySelectorAll("tr.group th")].map((th) => th.textContent);
    expect(headings).toEqual(["Watchlist1", "Equity index3"]);
  });

  it("should mark the open product's row and open another product on click", () => {
    const onOpen = vi.fn();
    const { container } = renderOverview({ onOpen });

    fireEvent.click(screen.getByRole("button", { name: /^Open DN in Detail/ }));

    expect([container.querySelectorAll("tr[aria-current='true']").length, rowOf(container, "UP").getAttribute("aria-current"), onOpen.mock.calls]).toEqual([
      1,
      "true",
      [["DN"]],
    ]);
  });

  it("should filter by text and offer the way back to the sector groups once sorted", () => {
    const { container } = renderOverview();

    fireEvent.change(screen.getByPlaceholderText("filter root or name"), { target: { value: "dn name" } });
    const rows = container.querySelectorAll("tbody tr:not(.group)").length;
    fireEvent.click(within(header("Vol")).getByRole("button"));

    expect([rows, screen.getByRole("button", { name: "Group by sector" }) !== null]).toEqual([1, true]);
  });
});

describe("OverviewTable watchlist star", () => {
  it("should give each product a star pressed only for the watched ones", () => {
    renderOverview();

    expect([
      screen.getByRole("button", { name: "Remove NA from the watchlist" }).getAttribute("aria-pressed"),
      screen.getByRole("button", { name: "Add UP to the watchlist" }).getAttribute("aria-pressed"),
    ]).toEqual(["true", "false"]);
  });

  it("should add a product on a star press without opening it", () => {
    const onWatch = vi.fn();
    const onOpen = vi.fn();
    renderOverview({ onWatch, onOpen });

    fireEvent.click(screen.getByRole("button", { name: "Add DN to the watchlist" }));

    expect([onWatch.mock.calls, onOpen.mock.calls]).toEqual([[["DN", true]], []]);
  });

  it("should remove a watched product on a star press", () => {
    const onWatch = vi.fn();
    renderOverview({ onWatch });

    fireEvent.click(screen.getByRole("button", { name: "Remove NA from the watchlist" }));

    expect(onWatch.mock.calls).toEqual([["NA", false]]);
  });

  it("should disable the stars of unwatched products when the watchlist is full but keep watched ones live", () => {
    const full = Array.from({ length: watchlistLimit - 1 }, (_, i) => `W${i}`).concat("NA");
    renderOverview({ watchlist: full });

    expect([
      (screen.getByRole("button", { name: "Add UP to the watchlist" }) as HTMLButtonElement).disabled,
      (screen.getByRole("button", { name: "Remove NA from the watchlist" }) as HTMLButtonElement).disabled,
    ]).toEqual([true, false]);
  });

  it("should leave an unwatched star enabled while the watchlist has room", () => {
    renderOverview();

    expect((screen.getByRole("button", { name: "Add UP to the watchlist" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("should draw a watched product the server refused depth for as the picker does", () => {
    renderOverview({ refused: ["NA"] });

    const star = screen.getByRole("button", { name: "Remove NA from the watchlist" });
    expect([star.textContent, star.getAttribute("title"), star.classList.contains("star-refused")]).toEqual([
      "☆",
      "no depth: limit reached",
      true,
    ]);
  });

  it("should draw a watched product the server pulls depth for as filled and not refused", () => {
    renderOverview({ refused: ["UP"] });

    const star = screen.getByRole("button", { name: "Remove NA from the watchlist" });
    expect([star.textContent, star.getAttribute("title"), star.classList.contains("star-refused")]).toEqual([
      "★",
      "watched: depth kept",
      false,
    ]);
  });

  it("should update every star when only the watchlist and refused set change and the summaries are the same", () => {
    const summaries = products();
    const full = Array.from({ length: watchlistLimit - 1 }, (_, i) => `W${i}`).concat("DN");
    const { rerender } = render(
      <OverviewTable summaries={summaries} watchlist={["NA"]} active="UP" refused={[]} onOpen={noop} onWatch={noop} />,
    );
    const before = [
      screen.getByRole("button", { name: "Add DN to the watchlist" }).getAttribute("aria-pressed"),
      (screen.getByRole("button", { name: "Add UP to the watchlist" }) as HTMLButtonElement).disabled,
    ];

    rerender(<OverviewTable summaries={summaries} watchlist={full} active="UP" refused={["DN"]} onOpen={noop} onWatch={noop} />);

    const pressed = screen.getByRole("button", { name: "Remove DN from the watchlist" });
    expect([
      before,
      pressed.getAttribute("aria-pressed"),
      pressed.getAttribute("title"),
      (screen.getByRole("button", { name: "Add UP to the watchlist" }) as HTMLButtonElement).disabled,
    ]).toEqual([["false", false], "true", "no depth: limit reached", true]);
  });

  describe("when only one star input changes and the summaries are the same", () => {
    const summaries = products();
    const props = { summaries, active: "UP", onOpen: noop, onWatch: noop };

    it("should follow a watchlist change that leaves the refused set and fullness alone", () => {
      const { rerender } = render(<OverviewTable {...props} watchlist={["NA"]} refused={[]} />);
      // Sorted, the table is one group, so the row stays mounted when it joins the watchlist.
      fireEvent.click(within(header("Last")).getByRole("button"));

      rerender(<OverviewTable {...props} watchlist={["NA", "DN"]} refused={[]} />);

      expect(screen.getByRole("button", { name: "Remove DN from the watchlist" }).getAttribute("aria-pressed")).toBe("true");
    });

    it("should follow a refused-set change that leaves the watchlist alone", () => {
      const { rerender } = render(<OverviewTable {...props} watchlist={["NA"]} refused={[]} />);

      rerender(<OverviewTable {...props} watchlist={["NA"]} refused={["NA"]} />);

      expect(screen.getByRole("button", { name: "Remove NA from the watchlist" }).getAttribute("title")).toBe("no depth: limit reached");
    });

    it("should follow the watchlist filling up when no row's own watched state changes", () => {
      const eleven = Array.from({ length: watchlistLimit - 1 }, (_, i) => `W${i}`);
      const { rerender } = render(<OverviewTable {...props} watchlist={eleven} refused={[]} />);
      const before = (screen.getByRole("button", { name: "Add UP to the watchlist" }) as HTMLButtonElement).disabled;

      rerender(<OverviewTable {...props} watchlist={[...eleven, "W11"]} refused={[]} />);

      expect([before, (screen.getByRole("button", { name: "Add UP to the watchlist" }) as HTMLButtonElement).disabled]).toEqual([false, true]);
    });
  });
});
