// @vitest-environment jsdom

import { cleanup, fireEvent, render as mount, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instrumentSummaryFixture } from "../test/fixtures.ts";
import { ProductPanel } from "./ProductPanel.tsx";

const noop = () => undefined;
const KEY = "futures-liquidity-dashboard.products-collapsed";

afterEach(cleanup);
beforeEach(() => globalThis.localStorage.clear());
const expanded = () => globalThis.localStorage.setItem(KEY, "false");
const summaries = [
  instrumentSummaryFixture({ root: "ES", sector: "Equity index" }, { last: 27_100 }),
  instrumentSummaryFixture({ root: "CL", name: "Crude Oil", sector: "Energy" }, {}, { depthSubscribed: false }),
  instrumentSummaryFixture({ root: "NG", name: "Natural Gas", sector: "Energy" }),
];

function render(watchlist: readonly string[] = ["ES", "NG"], refused: readonly string[] = []): string {
  return renderToString(
    <ProductPanel summaries={summaries} watchlist={watchlist} active="ES" refused={refused} onSelect={noop} onWatch={noop} />,
  );
}

describe("ProductPanel", () => {
  beforeEach(expanded);

  it("should list every product the API returns when it is expanded", () => {
    const html = render();

    expect(["Chart ES", "Chart CL", "Chart NG"].every((label) => html.includes(label))).toBe(true);
  });

  it("should put the watchlist group before the sectors when products are watched", () => {
    const html = render();

    expect(html.indexOf("Watchlist")).toBeLessThan(html.indexOf("Energy"));
  });

  it("should mark the product the charts show as pressed", () => {
    expect(render()).toMatch(/aria-pressed="true" aria-label="Chart ES/);
  });

  it("should show the DOM marker only for products whose depth the server holds", () => {
    expect(render().match(/>DOM</g)).toHaveLength(2);
  });

  it("should give a refused star the limit-reached title when the server refused its depth", () => {
    expect(render(["ES", "NG"], ["NG"])).toContain("no depth: limit reached");
  });

  it("should escape a product name rather than render it as markup", () => {
    const hostile = [instrumentSummaryFixture({ root: "ES", name: "<img src=x onerror=alert(1)>" })];

    const html = renderToString(<ProductPanel summaries={hostile} watchlist={[]} active="ES" refused={[]} onSelect={noop} onWatch={noop} />);

    expect(html).not.toContain("<img src=x");
  });

  it("should say so when the API listed no products", () => {
    const html = renderToString(<ProductPanel summaries={[]} watchlist={["ES"]} active="ES" refused={[]} onSelect={noop} onWatch={noop} />);

    expect(html).toContain("No products listed yet.");
  });
});

describe("ProductPanel collapsed row", () => {
  const props = { summaries, watchlist: ["ES", "NG"], active: "ES", refused: [], onWatch: noop };

  it("should open collapsed when the viewer has never chosen", () => {
    mount(<ProductPanel {...props} onSelect={noop} />);

    expect([
      screen.getByRole("button", { name: /^Products/ }).getAttribute("aria-expanded"),
      screen.queryByRole("table"),
    ]).toEqual(["false", null]);
  });

  it("should name the disclosure button with the product count when it is collapsed", () => {
    mount(<ProductPanel {...props} onSelect={noop} />);

    expect(screen.getByRole("button", { name: "Products 3" })).toBeTruthy();
  });

  it("should list the watchlist as buttons and mark the open product pressed when it is collapsed", () => {
    mount(<ProductPanel {...props} onSelect={noop} />);

    const list = screen.getByRole("list", { name: "Watchlist" });

    expect([
      within(list).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
    ]).toEqual([[["★ES", "true"], ["★NG", "false"]]]);
  });

  it("should open the product when its watchlist button is pressed", () => {
    const onSelect = vi.fn();
    mount(<ProductPanel {...props} onSelect={onSelect} />);

    fireEvent.click(within(screen.getByRole("list", { name: "Watchlist" })).getByRole("button", { name: /NG/ }));

    expect(onSelect.mock.calls).toEqual([["NG"]]);
  });

  it("should keep the filter field beside the row when it is collapsed", () => {
    mount(<ProductPanel {...props} onSelect={noop} />);

    expect(screen.getByRole("searchbox", { name: "Filter products" })).toBeTruthy();
  });

  it("should expand the table already narrowed when the viewer types in the filter while it is collapsed", () => {
    mount(<ProductPanel {...props} onSelect={noop} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter products" }), { target: { value: "NG" } });

    expect([
      screen.getByRole("button", { name: /^Products/ }).getAttribute("aria-expanded"),
      screen.queryByRole("button", { name: /^Chart ES/ }),
      screen.getByRole("button", { name: /^Chart NG/ }) !== null,
      globalThis.localStorage.getItem(KEY),
    ]).toEqual(["true", null, true, null]);
  });

  it("should stay collapsed when the filter is cleared to empty after the viewer collapsed it again", () => {
    mount(<ProductPanel {...props} onSelect={noop} />);
    const filter = () => screen.getByRole("searchbox", { name: "Filter products" });
    fireEvent.change(filter(), { target: { value: "NG" } });
    fireEvent.click(screen.getByRole("button", { name: /^Products/ }));

    fireEvent.change(filter(), { target: { value: "" } });

    expect(screen.queryByRole("table")).toBeNull();
  });

  it("should show the table and drop the watchlist buttons when the disclosure button is pressed", () => {
    mount(<ProductPanel {...props} onSelect={noop} />);

    fireEvent.click(screen.getByRole("button", { name: /^Products/ }));

    expect([screen.getByRole("button", { name: /^Products/ }).getAttribute("aria-expanded"), screen.getByRole("table") !== null, screen.queryByRole("list", { name: "Watchlist" })]).toEqual([
      "true",
      true,
      null,
    ]);
  });

  it("should restore the viewer's own choice to expand when it was stored", () => {
    expanded();
    mount(<ProductPanel {...props} onSelect={noop} />);

    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("should restore the viewer's own choice to collapse when it was stored", () => {
    globalThis.localStorage.setItem(KEY, "true");
    mount(<ProductPanel {...props} onSelect={noop} />);

    expect(screen.queryByRole("table")).toBeNull();
  });
});
