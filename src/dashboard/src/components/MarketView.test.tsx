import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { chartKeyHint } from "../domain/chartCursor.ts";
import { defaultLayout, withIcebergFloors, withPane, withSignal } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { MarketView } from "./MarketView.tsx";

const market = fromSnapshot(snapshotFixture(), 5, 0);
const noop = () => undefined;

function render(layout = defaultLayout): string {
  return renderToString(
    <MarketView
      market={market}
      layout={layout}
      viewWindow={defaultWindow(5)}
      crosshair={createCrosshairStore()}
      onWindow={noop}
      onResetWindow={noop}
      onTogglePane={noop}
      onToggleKind={noop}
    />,
  );
}

describe("MarketView", () => {
  it("should show the depth ladder when the ladder pane is on", () => {
    expect(render()).toContain("Depth ladder");
  });

  it("should hide the depth ladder when the ladder pane is off", () => {
    expect(render(withPane(defaultLayout, "ladder", false))).not.toContain("Depth ladder");
  });

  // (the spoof sits in a closed group, whose members mount on open)
  it("should list a signal's kind in its group row when its kind is on", () => {
    expect(render(withSignal(defaultLayout, "Spoof", true))).toMatch(/Spoof \d+ %/);
  });

  it("should hide a spoof when only the default signal kinds are on", () => {
    expect(render()).not.toMatch(/Spoof \d+ %/);
  });

  it("should leave out an iceberg below the layout's strength floor and count it when the floor is saved", () => {
    const iceberg = market.orderFlow.signals.find((s) => s.kind === "Iceberg");

    expect(render()).toContain(iceberg?.label);
    const floored = render(withIcebergFloors(defaultLayout, { minStrengthPercent: 40, minHiddenSize: 0 }));
    expect(floored).not.toContain(iceberg?.label);
    expect(floored).toContain("1 below floors");
  });

  it("should not list a signal when its kind is toggled off", () => {
    expect(render(withSignal(defaultLayout, "Spoof", false))).not.toMatch(/Spoof \d+ %/);
  });

  it("should escape server text rather than render it as markup", () => {
    const hostile = { ...market, orderFlow: { ...market.orderFlow, signals: [{ ...market.orderFlow.signals[0]!, label: "<img src=x onerror=alert(1)>" }] } };

    const html = renderToString(
      <MarketView market={hostile} layout={defaultLayout} viewWindow={defaultWindow(5)} crosshair={createCrosshairStore()} onWindow={noop} onResetWindow={noop} onTogglePane={noop} onToggleKind={noop} />,
    );

    expect(html).not.toContain("<img src=x");
  });

  it("should show the volume tab and leave the other indicator panes unmounted", () => {
    const html = render();

    expect(html).toContain('aria-label="Indicator panes"');
    expect(html).toMatch(/aria-selected="true"[^>]*>Volume</);
    expect(html).toContain("Traded volume of");
    expect(html).not.toContain("TPO profile");
    expect(html).not.toMatch(/aria-label="[^"]*RSI/);
  });

  it("should show the TPO profile when that indicator tab is selected", () => {
    const html = render({ ...defaultLayout, indicatorPane: "tpo" });

    expect(html).toContain("TPO profile");
    expect(html).toMatch(/aria-selected="true"[^>]*>TPO</);
    expect(html).not.toContain("Traded volume of");
  });

  it("should say the product has no depth, on the chart and in the DOM pane, when the server is not receiving it", () => {
    const tradesOnly = { ...market, status: { ...market.status, depthSubscribed: false } };

    const html = renderToString(
      <MarketView market={tradesOnly} layout={defaultLayout} viewWindow={defaultWindow(5)} crosshair={createCrosshairStore()} onWindow={noop} onResetWindow={noop} onTogglePane={noop} onToggleKind={noop} />,
    );

    expect([html.includes("Trades and quotes only: no depth for this product right now"), html.includes("not receiving depth")]).toEqual([true, true]);
  });

  it("should show no depth note when the server holds the product's depth", () => {
    expect(render()).not.toContain("Trades and quotes only");
  });

  it("should make the chart focusable and offer a polite readout and a keyboard hint", () => {
    const html = render();

    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="application"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(chartKeyHint);
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("MarketView side column", () => {
  it("should show every side panel when nothing has been opened", () => {
    const html = render();

    for (const name of ["Depth ladder", "Liquidity metrics", "Order-flow signals", "Levels", "Layers"]) {
      expect(html, name).toContain(`aria-label="${name}"`);
    }
  });

  it("should put the side column beside the charts rather than in a fold", () => {
    const html = render();

    expect(html).toContain('class="side-column"');
    expect(html).not.toContain("<details");
    expect(html).not.toContain("Signals, layers and liquidity");
    expect(html).not.toContain("aria-label=\"Side panel\"");
  });

  it("should keep the layer toggles reachable when the column is shown", () => {
    expect(render()).toContain("Liquidity heatmap");
  });

  it("should keep the indicator dock inside the chart column when the side column is shown", () => {
    const html = render();

    expect(html.indexOf("indicator-tabs")).toBeGreaterThan(html.indexOf('class="chart-column"'));
    expect(html.indexOf("indicator-tabs")).toBeLessThan(html.indexOf('class="side-column"'));
  });
});

describe("MarketView signals and levels", () => {
  it("should print each signal's bias and strength in its row when signals are listed", () => {
    const html = render().replaceAll("<!-- -->", "");

    expect(html).toMatch(/class="detail">[^<]*· bearish · strength 35 ?%/);
  });

  it("should print each level's kind and list the levels from the highest price down", () => {
    const html = render().replaceAll("<!-- -->", "");
    const prices = [...html.matchAll(/<li class="ld-level[^"]*"><span class="kind">[^<]*<\/span><span class="ld-level-type">[^<]+<\/span>([\d.]+)<\/li>/g)].map((m) => Number(m[1]));

    expect(prices.length).toBeGreaterThan(1);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
  });
});
