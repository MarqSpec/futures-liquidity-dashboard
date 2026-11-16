import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { defaultLayout, nextHeatCutoffs } from "../domain/layout.ts";
import { LayersPanel } from "./LayersPanel.tsx";

describe("LayersPanel", () => {
  it("should keep the lower heat cutoff below the upper one when a slider crosses the other", () => {
    expect(nextHeatCutoffs(5, 95, "low", 99)).toEqual({ heatLowPercentile: 94, heatHighPercentile: 95 });
    expect(nextHeatCutoffs(80, 90, "high", 10)).toEqual({ heatLowPercentile: 80, heatHighPercentile: 81 });
  });

  it("should offer the heatmap cutoff sliders when the layers are shown", () => {
    const html = renderToString(
      <LayersPanel
        isPaneOn={() => true}
        onToggle={() => undefined}
        indicators={[]}
        layout={defaultLayout}
        onReading={() => undefined}
      />,
    );

    expect(html).toContain("Heatmap lower percentile");
    expect(html).toContain("Heatmap upper percentile");
    expect(html).toContain("RIPS layout");
    expect(html).toContain("Liquidity heatmap");
  });

  it("should leave the indicator dock tabs out of the layer checkboxes", () => {
    const html = renderToString(
      <LayersPanel
        isPaneOn={() => true}
        onToggle={() => undefined}
        indicators={[]}
        layout={defaultLayout}
        onReading={() => undefined}
      />,
    );

    expect(html).not.toContain("Footprint");
    expect(html).not.toContain(">CVD<");
    expect(html).not.toContain("RSI 14");
    expect(html).not.toContain("MACD 12/26/9");
    expect(html).not.toContain("ATR 14");
    expect(html).not.toContain(">TPO<");
  });
});
