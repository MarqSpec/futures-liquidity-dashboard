// The hint texts: one sentence each, on what the control changes, for the controls whose purpose is not obvious from
// the label. Interval, window and zoom buttons have none. They live here, not in the markup, so the wording is
// reviewed in one place (REQUIREMENTS.md UC-14, UC-16; ARCHITECTURE.md D-47).

/** Hint text by control. Each value is a single sentence. */
export const hints = {
  presetNodes:
    "Emphasizes the volume profile's high-volume nodes (HVN), where price lingered, and low-volume nodes (LVN), where it moved quickly.",
  presetValueArea:
    "Emphasizes the value area, the price range holding most of the volume, with its point of control (POC) and its high and low (VAH and VAL).",
  heatIntensity: "Colors each heatmap cell by how much size was resting at that price, brighter for more.",
  heatFlow: "Colors each heatmap cell by how resting size changed, one color for size added and another for size pulled.",
  heatContrast: "Stretches or flattens the heatmap colors, so higher values make small differences in resting size easier to see.",
  live: "Returns the chart to the newest data and keeps it following as new data arrives.",
  displayDimming: "Dims the heatmap behind the dots, so prints stand out from the resting size.",
  displayMinDot: "Hides volume dots smaller than this print size, so only the larger prints show.",
  displayEventDots: "Sets how large the detected-event markers are drawn, without changing the volume dots.",
  displayCandles: "Draws price candles over the heatmap.",
  displayPriceLine: "Draws the last traded price over time as a line.",
  displayBbo: "Draws the best bid and best ask as thin lines.",
  displayPnc: "Shows the failed-reclaim markers and the read-only trail guide, which is not an order.",
  displayKey: "Shows what each event marker color and shape means.",
  displayRangeZones: "Shades each stretch where the product was ranging, between that stretch's high and low.",
  displayRangeZoneBars: "Chooses whether 15-minute or 5-minute bars decide where the product was ranging, or hides the zones.",
  regime5m: "The market regime on 5-minute bars: trending up or down, ranging, or unclear.",
  regime15m: "The market regime on 15-minute bars: trending up or down, ranging, or unclear.",
} as const;

export type HintKey = keyof typeof hints;
