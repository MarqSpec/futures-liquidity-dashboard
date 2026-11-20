import { afterEach, describe, expect, it } from "vitest";

import { rgbTriplet } from "../design/color.ts";
import { color, fontFamilies } from "../design/tokens.ts";
import { READ_ONLY_TRAIL, WARMUP_NO_L2, bookmapFrame, bookmapScales } from "../domain/bookmap.ts";
import { eventMarker } from "../domain/signals.ts";
import { THIN_TAPE_ALPHA } from "../domain/tape.ts";
import { canvasFaces } from "../lib/canvasFonts.ts";
import { bookmapModel } from "../test/bookmapFixtures.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { canvasTheme } from "../theme.ts";
import { drawBookmap, type BookmapDrawModel } from "./drawBookmap.ts";

const model = bookmapModel;

function texts(calls: readonly { method: string; args: readonly unknown[] }[]): string[] {
  return calls.filter((call) => call.method === "fillText").map((call) => String(call.args[0]));
}

describe("drawBookmap", () => {
  it("should label warmup, the dock, a large dot, the failed reclaim and the read-only guide", () => {
    const { surface, calls } = fakeSurface(1100, 640);
    drawBookmap(surface, model());
    const painted = texts(calls).join(" | ");

    expect(painted).toContain(WARMUP_NO_L2);
    expect(painted).toContain("PRICE");
    expect(painted).toContain("COB (L2)");
    expect(painted).toContain("SVP (B/S)");
    expect(painted).toContain("5,000");
    expect(painted).not.toContain("failed reclaim");
    expect(painted).not.toContain("Liquidity sweep");
    expect(painted).toContain(READ_ONLY_TRAIL);
    expect(painted).toContain("Not an order");
    // — CVD is a dock tab now.
    expect(painted).not.toContain("LIVE CVD");
    expect(painted).toContain("PDH");
    expect(painted).toContain("HVN");
    const sweep = eventMarker("LiquiditySweep").color;
    const reclaim = eventMarker("FailedReclaim").color;
    expect(calls.some((call) => call.method === "stroke" && call.fillStyle === sweep)).toBe(true);
    expect(calls.some((call) => call.method === "stroke" && call.fillStyle === reclaim)).toBe(true);
  });

  it("should stroke the last-price line on both sides of the watermark and stop when it is off", () => {
    const on = model({
      showCandles: false,
      showPriceLine: true,
      priceSteps: [
        { timeMs: 0, priceTicks: 100 },
        { timeMs: 120_000, priceTicks: 107 },
      ],
    });
    const { surface, calls } = fakeSurface(1100, 640);
    drawBookmap(surface, on);
    const markX = bookmapScales(on.frame, on.startMs, on.endMs, on.lowTicks, on.highTicks).time.toPx(30_000);
    const xs = (style: string) =>
      calls
        .filter((call) => (call.method === "moveTo" || call.method === "lineTo") && call.strokeStyle === style)
        .map((call) => call.args[0] as number);

    expect(xs(color("warmup")).some((x) => x < markX)).toBe(true);
    expect(calls.some((call) => call.method === "setLineDash" && Array.isArray(call.args[0]) && (call.args[0] as unknown[]).length > 0)).toBe(true);
    expect(xs(color("price-line")).some((x) => x > markX)).toBe(true);

    const off = fakeSurface(1100, 640);
    drawBookmap(off.surface, model({ showCandles: false, showPriceLine: false, priceSteps: on.priceSteps }));
    expect(off.calls.some((call) => call.strokeStyle === color("price-line"))).toBe(false);
  });

  it("should start a new stroke where the price line has a hole", () => {
    const { surface, calls } = fakeSurface(1100, 640);
    const drawn = model({
      showCandles: false,
      showPriceLine: true,
      historyWatermarkMs: null,
      priceSteps: [
        { timeMs: 40_000, priceTicks: 100 },
        { timeMs: 80_000, priceTicks: 110, breakBefore: true },
      ],
    });
    drawBookmap(surface, drawn);
    const moves = calls.filter((call) => call.method === "moveTo" && call.strokeStyle === color("price-line"));

    expect(moves).toHaveLength(2);
  });

  it("should hold the previous price at the watermark instead of inventing one between the neighbours", () => {
    // Halfway from 0 to 120 s, so a restored interpolation of 100→110 is 105, not a price this assertion would miss.
    const drawn = model({
      showCandles: false,
      showPriceLine: true,
      historyWatermarkMs: 60_000,
      priceSteps: [
        { timeMs: 0, priceTicks: 100 },
        { timeMs: 120_000, priceTicks: 110 },
      ],
    });
    const { surface, calls } = fakeSurface(1100, 640);
    drawBookmap(surface, drawn);
    const scales = bookmapScales(drawn.frame, drawn.startMs, drawn.endMs, drawn.lowTicks, drawn.highTicks);
    const markX = scales.time.toPx(60_000);
    const heldY = scales.price.toPx(100);
    const inventedY = scales.price.toPx(105);
    const near = (left: unknown, right: number) => typeof left === "number" && Math.abs(left - right) < 0.01;
    const atMark = calls.filter((call) => (call.method === "moveTo" || call.method === "lineTo") && near(call.args[0], markX));

    expect(atMark.some((call) => near(call.args[1], heldY))).toBe(true);
    expect(atMark.some((call) => near(call.args[1], inventedY))).toBe(false);
  });

  it("should draw event markers at the saved radius and leave volume dots on theirs", () => {
    const { surface, calls } = fakeSurface(1100, 640);
    drawBookmap(surface, model({ eventDotRadius: 14 }));
    const radii = calls.filter((call) => call.method === "arc").map((call) => call.args[2]);

    expect(radii).toContain(14);
    expect(radii).toContain(9);
  });

  it("should say depth is not subscribed and paint warmup volume gray", () => {
    const { surface, calls } = fakeSurface(1100, 640);
    drawBookmap(surface, model({ cob: { kind: "empty", label: "depth not subscribed" } }));
    const painted = texts(calls).join(" ");

    expect(painted).toContain("depth");
    expect(painted).toContain("subscribed");
    expect(calls.some((call) => call.method === "fillRect" && call.fillStyle === color("warmup"))).toBe(true);
  });

  it("should say the book is recovering and hide the guide when PNC is off", () => {
    const { surface, calls } = fakeSurface(1100, 640);
    drawBookmap(surface, model({ showPnc: false, cob: { kind: "empty", label: "book recovering" } }));
    const painted = texts(calls).join(" ");

    expect(painted).toContain("book recovering");
    expect(painted).not.toContain("failed reclaim");
    expect(painted).not.toContain(READ_ONLY_TRAIL);
  });

  it("should stroke the best bid bid and the best ask ask when BBO is on", () => {
    // The quote is a side of the book, not a price direction: it never takes up or down.
    const strokes = (showBbo: boolean) => {
      const { surface, calls } = fakeSurface(1100, 640);
      drawBookmap(surface, model({ showBbo }));
      return calls.filter((call) => call.method === "stroke").map((call) => call.strokeStyle);
    };
    const without = new Set(strokes(false));

    expect(strokes(true).filter((style) => !without.has(style))).toEqual([color("bid"), color("ask")]);
  });

  it("should say the quote is unknown when the best bid and ask are stale", () => {
    const { surface, calls } = fakeSurface(1100, 640);
    drawBookmap(surface, model({ bboStale: true }));

    expect(texts(calls)).toContain("BBO unknown");
  });
});

describe("drawBookmap PNC toggle", () => {
  /** How many event dots (radius 4.5, hollow) were stroked in `kind`'s colour. */
  function dotsOf(calls: readonly CanvasCall[], kind: string): number {
    const colour = eventMarker(kind).color;
    return calls.filter((call, i) => {
      if (call.method !== "arc" || call.args[2] !== 4.5) return false;
      const paint = calls.slice(i + 1).find((next) => next.method === "stroke" || next.method === "fill");
      return paint?.method === "stroke" && paint.strokeStyle === colour;
    }).length;
  }

  it("should draw the detected-event dot and neither the failed-reclaim marker nor the guide when PNC is off", () => {
    const { surface, calls } = fakeSurface(1100, 640);

    drawBookmap(surface, model({ showPnc: false }));

    expect(eventMarker("LiquiditySweep").color).not.toBe(eventMarker("FailedReclaim").color);
    expect(dotsOf(calls, "LiquiditySweep")).toBe(1);
    expect(dotsOf(calls, "FailedReclaim")).toBe(0);
    expect(texts(calls).join(" ")).not.toContain(READ_ONLY_TRAIL);
  });

  it("should draw the event dot, the failed-reclaim marker and the guide when PNC is on", () => {
    const { surface, calls } = fakeSurface(1100, 640);

    drawBookmap(surface, model({ showPnc: true }));

    expect(dotsOf(calls, "LiquiditySweep")).toBe(1);
    expect(dotsOf(calls, "FailedReclaim")).toBe(1);
    expect(texts(calls).join(" ")).toContain(READ_ONLY_TRAIL);
  });
});

describe("drawBookmap colours", () => {
  const alpha = (token: string, value: number) => `rgba(${rgbTriplet(color(token))}, ${value})`;

  /** The fake surface, with the font in force at each fillText, which the shared recorder does not keep. */
  function paint(drawn: BookmapDrawModel): { readonly calls: CanvasCall[]; readonly fonts: Map<string, string> } {
    const { surface, calls } = fakeSurface(1100, 640);
    const fonts = new Map<string, string>();
    const ctx = new Proxy(surface.ctx, {
      get(target, key) {
        if (key === "fillText") {
          return (text: string, x: number, y: number) => {
            fonts.set(text, String(target.font));
            target.fillText(text, x, y);
          };
        }
        return Reflect.get(target, key) as unknown;
      },
      set(target, key, value) {
        return Reflect.set(target, key, value);
      },
    });
    drawBookmap({ ...surface, ctx }, drawn);
    return { calls, fonts };
  }

  const filledText = (calls: readonly CanvasCall[], text: string) =>
    calls.find((call) => call.method === "fillText" && call.args[0] === text)?.fillStyle;

  const lastBefore = (calls: readonly CanvasCall[], text: string, method: string, style: "fillStyle" | "strokeStyle") => {
    const label = calls.findIndex((call) => call.method === "fillText" && call.args[0] === text);
    if (label < 0) return undefined;
    return calls.slice(0, label).reverse().find((call) => call.method === method)?.[style];
  };

  it("should keep today's Terminal values under the token names when the Terminal theme is read", () => {
    // The aggressor pair follows up and down, which a separate change moved to blue and grey.
    expect(color("aggressor-buy")).toBe("#6f84ff");
    expect(color("aggressor-sell")).toBe("#b0b0b0");
    // a separate change lifted warmup to the 3:1 line floor.
    expect(color("warmup")).toBe("#686e79");
    expect(color("node-hvn")).toBe("#ffd54f");
    expect(color("node-lvn")).toBe("#4fc3f7");
    expect(color("node-neutral")).toBe("#8d97a8");
    expect(color("guide-fill")).toBe("#2a2416");
    expect(color("guide-text")).toBe("#ffe082");
    expect(color("price-tag")).toBe("#f5d76e");
    expect(color("on-price-tag")).toBe("#1a1404");
    // the dot quantity is dark on the blue and grey Terminal dots; the guide caption keeps the light value.
    expect(color("dot-label")).toBe("#08090c");
    expect(color("guide-caption")).toBe("#f5f7fb");
    expect(color("dot-label-halo")).toBe("#f3f1ea");
    expect(color("surface-lowest")).toBe("#08090c");
    // D-40's price-line constants, now tokens: Terminal keeps their values.
    expect(color("price-line")).toBe("#f6f3ea");
    expect(color("price-line-halo")).toBe("#140e08");
    expect(color("price-line-halo-warmup")).toBe("#2a303a");
  });

  it("should paint a dot as an aggressor-sell disc with an aggressor-buy slice from 12 o'clock when a dot has both sides", () => {
    const { calls } = paint(model({ showCandles: false, showPnc: false }));
    const arcs = calls.filter((call) => call.method === "arc" && call.args[2] === 9);
    const disc = arcs.find((call) => call.args[3] === 0);
    const slice = arcs.find((call) => call.args[3] === -Math.PI / 2);
    const fillAfter = (arc: CanvasCall | undefined) =>
      arc === undefined ? undefined : calls.slice(calls.indexOf(arc)).find((call) => call.method === "fill")?.fillStyle;

    expect(fillAfter(disc)).toBe(color("aggressor-sell"));
    expect(fillAfter(slice)).toBe(color("aggressor-buy"));
  });

  it("should print a large dot's quantity in dot-label, bold mono when the dot is labelled", () => {
    const { calls, fonts } = paint(model());

    expect(filledText(calls, "5,000")).toBe(color("dot-label"));
    expect(fonts.get("5,000")).toBe(`700 10px ${fontFamilies.mono}`);
  });

  it("should stroke a large dot's quantity in dot-label-halo before filling it in dot-label in both themes when the label is wider than its dot", () => {
    // "5,000" is 30px on an 18px dot: the overflow sits on the stage, so the halo goes under every glyph.
    const haloThenFill = (calls: readonly CanvasCall[]) => {
      const stroke = calls.findIndex((call) => call.method === "strokeText" && call.args[0] === "5,000");
      const fill = calls.findIndex((call) => call.method === "fillText" && call.args[0] === "5,000");
      return {
        order: stroke > -1 && stroke < fill,
        halo: calls[stroke]?.strokeStyle,
        width: calls[stroke]?.lineWidth,
        join: calls[stroke]?.lineJoin,
        label: calls[fill]?.fillStyle,
      };
    };

    const dark = haloThenFill(paint(model()).calls);
    canvasTheme.set("light");
    let light: ReturnType<typeof haloThenFill>;
    try {
      light = haloThenFill(paint(model()).calls);
    } finally {
      canvasTheme.set("dark");
    }

    // DOT_LABEL_HALO: 3px, so 1.5px of halo outside each glyph edge.
    expect(dark).toEqual({ order: true, halo: color("dot-label-halo"), width: 3, join: "round", label: color("dot-label") });
    expect(light).toEqual({ order: true, halo: color("dot-label-halo", "light"), width: 3, join: "round", label: color("dot-label", "light") });
  });

  it("should stroke the warmup line, candle wicks and best bid and ask 1px with miter joins on every frame when a labelled dot was drawn before", () => {
    // The dot label's halo is 3px with round joins; it must not reach the next frame's strokes.
    const { surface, calls } = fakeSurface(1100, 640);
    const drawn = model({ frame: bookmapFrame(1100, 640), hover: null, signals: [], reclaims: [], guide: null, showPnc: false });
    const strokes = (from: number, to: number) =>
      calls
        .slice(from, to)
        .filter((call) => call.method === "stroke")
        .map((call) => `${String(call.strokeStyle)}@${String(call.lineWidth)}/${String(call.lineJoin)}`);

    drawBookmap(surface, drawn);
    const firstEnd = calls.length;
    drawBookmap(surface, drawn);

    const first = strokes(0, firstEnd);
    const second = strokes(firstEnd, calls.length);
    expect(second).toEqual(first);
    const watched = [color("warmup"), color("up"), color("bid"), color("ask")];
    const ofWatched = second.filter((entry) => watched.some((style) => entry.startsWith(`${style}@`)));
    expect(new Set(ofWatched)).toEqual(new Set(watched.map((style) => `${style}@1/miter`)));
  });

  it("should set its own stroke width when the context arrives with another draw's state", () => {
    // Each stroke owns its state, so none depends on what an earlier draw left behind.
    const plain = { hover: null, signals: [], reclaims: [], guide: null, showPnc: false, dots: [] };
    const frame = bookmapFrame(1100, 640);
    const cases = [
      { name: "warmup", drawn: model({ ...plain, frame }), styles: [color("warmup")], expected: "1" },
      { name: "candles", drawn: model({ ...plain, frame, historyWatermarkMs: null }), styles: [color("up")], expected: "1" },
      { name: "bbo", drawn: model({ ...plain, frame, historyWatermarkMs: null, showCandles: false, levels: [] }), styles: [color("bid"), color("ask")], expected: "1" },
    ];
    const seen = cases.map(({ name, drawn, styles, expected }) => {
      const { surface, calls } = fakeSurface(1100, 640);
      surface.ctx.lineWidth = 7;
      surface.ctx.lineJoin = "bevel";
      drawBookmap(surface, drawn);
      const strokes = calls.filter((call) => call.method === "stroke" && styles.includes(String(call.strokeStyle)));
      const shown = strokes.map((call) => (expected.includes("/") ? `${String(call.lineWidth)}/${String(call.lineJoin)}` : String(call.lineWidth)));
      return { name, count: strokes.length > 0, values: [...new Set(shown)] };
    });

    expect(seen).toEqual(cases.map(({ name, expected }) => ({ name, count: true, values: [expected] })));
  });

  it("should paint warmup history, its band and its volume in warmup grey when the window crosses the watermark", () => {
    const { calls } = paint(model());

    expect(calls.some((call) => call.method === "fillRect" && call.fillStyle === color("warmup"))).toBe(true);
    // a separate change eased the band from 0.28 so the marks on it hold NFR-8's floors.
    expect(calls.some((call) => call.method === "fillRect" && call.fillStyle === alpha("warmup", 0.25))).toBe(true);
    expect(calls.some((call) => call.method === "stroke" && call.strokeStyle === color("warmup"))).toBe(true);
  });

  it("should shade an HVN shelf in node-hvn and an LVN shelf in node-lvn, at 32% when emphasised and 16% when not, when both shelves are in view", () => {
    const levels = [
      { name: "HVN", priceTicks: 106, emphasis: "hvn" as const },
      { name: "LVN", priceTicks: 96, emphasis: "lvn" as const },
    ];
    const strong = paint(model({ levels, emphasizeNodes: true })).calls;
    const quiet = paint(model({ levels, emphasizeNodes: false })).calls;
    const bands = (calls: readonly CanvasCall[]) => calls.filter((call) => call.method === "fillRect").map((call) => call.fillStyle);
    const rules = (calls: readonly CanvasCall[]) => calls.filter((call) => call.method === "stroke").map((call) => call.strokeStyle);

    expect(bands(strong)).toEqual(expect.arrayContaining([alpha("node-hvn", 0.32), alpha("node-lvn", 0.32)]));
    expect(bands(quiet)).toEqual(expect.arrayContaining([alpha("node-hvn", 0.16), alpha("node-lvn", 0.16)]));
    expect(bands(quiet)).not.toContain(alpha("node-hvn", 0.32));
    expect(rules(strong)).toEqual(expect.arrayContaining([color("node-hvn"), color("node-lvn")]));
  });

  it("should tag a named level in node-neutral, POC in poc and VWAP in vwap when they are in view", () => {
    const { calls } = paint(
      model({
        levels: [
          { name: "PDH", priceTicks: 110, emphasis: "level" },
          { name: "POC", priceTicks: 102, emphasis: "level" },
          { name: "VWAP", priceTicks: 99, emphasis: "level" },
        ],
      }),
    );

    expect(filledText(calls, "PDH")).toBe(color("node-neutral"));
    expect(lastBefore(calls, "PDH", "strokeRect", "strokeStyle")).toBe(color("node-neutral"));
    expect(filledText(calls, "POC")).toBe(color("poc"));
    expect(lastBefore(calls, "POC", "strokeRect", "strokeStyle")).toBe(color("poc"));
    expect(filledText(calls, "VWAP")).toBe(color("vwap"));
    expect(lastBefore(calls, "VWAP", "strokeRect", "strokeStyle")).toBe(color("vwap"));
  });

  it("should box the trade guide in guide-fill with guide-text and caption it Not an order in guide-caption when the guide is drawn", () => {
    const { calls } = paint(model());

    expect(filledText(calls, READ_ONLY_TRAIL)).toBe(color("guide-text"));
    expect(lastBefore(calls, READ_ONLY_TRAIL, "fillRect", "fillStyle")).toBe(color("guide-fill"));
    expect(filledText(calls, "Not an order")).toBe(color("guide-caption"));
    expect(lastBefore(calls, "Not an order", "fillRect", "fillStyle")).toBe(color("guide-fill"));
    expect(calls.some((call) => call.method === "stroke" && call.strokeStyle === color("guide-text"))).toBe(true);
  });

  it("should tag the last price in price-tag with on-price-tag text when it is in view", () => {
    const { calls } = paint(model());

    expect(filledText(calls, "26.75")).toBe(color("on-price-tag"));
    expect(lastBefore(calls, "26.75", "fillRect", "fillStyle")).toBe(color("price-tag"));
  });

  it("should paint the stage and the dock on the surface tokens and the book and profile on their sides when a frame is painted", () => {
    const { calls } = paint(model());
    const fills = calls.filter((call) => call.method === "fillRect").map((call) => call.fillStyle);

    expect(fills[0]).toBe(color("surface-lowest"));
    expect(fills).toEqual(expect.arrayContaining([color("surface-low")]));
    expect(fills).toEqual(expect.arrayContaining([color("bid"), color("ask")]));
  });

  it("should set the column heads in label-sm capitals and every other label in IBM Plex Mono when a frame is painted", () => {
    const { fonts } = paint(model());
    const heads = ["PRICE", "COB (L2)", "SVP (B/S)"];

    for (const head of heads) expect(fonts.get(head)).toBe(`600 11px ${fontFamilies.sans}`);
    const others = [...fonts.entries()].filter(([text]) => !heads.includes(text));
    expect(others.length).toBeGreaterThan(5);
    for (const [text, font] of others) expect({ text, mono: font.endsWith(` ${fontFamilies.mono}`) }).toEqual({ text, mono: true });
  });

  it("should paint every face from the font watcher's list when a full frame is painted", () => {
    // A face missing from the list is not awaited, so its text stays in the fallback face after the redraw.
    const { fonts } = paint(model());
    const painted = [...new Set(fonts.values())];

    expect(painted.length).toBeGreaterThanOrEqual(4);
    expect(painted.filter((font) => !canvasFaces.includes(font))).toEqual([]);
  });
});

describe("drawBookmap heat scale", () => {
  // Resting sizes 10, 15, … 100 and one 1,000-lot wall in one column: at p5–p95 the cutoffs are 14.75 and 145.
  const sizes = [...Array.from({ length: 19 }, (_, index) => 10 + index * 5), 1_000];
  const intensity = [{ t: 60_000, d: 60_000, c: sizes.flatMap((size, index) => [100 + index, size, 0, 60_000]) }];
  // Flow: the second column changes three sizes by +10, −20 and +40 (the first has no column before it, so no change).
  const flow = [
    { t: 0, d: 60_000, c: [100, 10, 0, 60_000, 101, 30, 0, 60_000, 102, 50, 0, 60_000] },
    { t: 60_000, d: 60_000, c: [100, 20, 0, 60_000, 101, 10, 0, 60_000, 102, 90, 0, 60_000] },
  ];
  const scaleOf = (overrides: Partial<BookmapDrawModel>) =>
    drawBookmap(
      fakeSurface(1100, 640).surface,
      model({ heatColumns: intensity, lowTicks: 90, highTicks: 130, heatLowPercentile: 5, heatHighPercentile: 95, ...overrides }),
    );

  // The key prints the cutoffs the ramp maps between, never a value derived from contrast (the maintainer's ruling).
  it.each([
    { scale: "auto-contrast", contrast: 0.5, low: 14.75, high: 145 },
    { scale: "auto-contrast", contrast: 1, low: 14.75, high: 145 },
    { scale: "auto-contrast", contrast: 2, low: 14.75, high: 145 },
    { scale: "fixed log", contrast: 0.5, low: 0, high: 1_000 },
    { scale: "fixed log", contrast: 1, low: 0, high: 1_000 },
    { scale: "fixed log", contrast: 2, low: 0, high: 1_000 },
    { scale: "flow", contrast: 0.5, low: 0, high: 40 },
    { scale: "flow", contrast: 1, low: 0, high: 40 },
    { scale: "flow", contrast: 2, low: 0, high: 40 },
  ])("should report the cutoffs $low and $high when the $scale scale has contrast $contrast", ({ scale, contrast, low, high }) => {
    const reported = scaleOf({
      heatContrast: contrast,
      heatAutoContrast: scale === "auto-contrast",
      heatMode: scale === "flow" ? "flow" : "intensity",
      heatColumns: scale === "flow" ? flow : intensity,
    });

    expect(reported?.low).toBeCloseTo(low, 6);
    expect(reported?.high).toBeCloseTo(high, 6);
  });

  it("should report no scale when no heat is in view", () => {
    expect(scaleOf({ heatColumns: [] })).toBeNull();
  });
});

// (REQUIREMENTS.md FR-83)
describe("drawBookmap thin-tape markers", () => {
  it("should dim an event marker raised on a thin tape and leave the others at full strength", () => {
    const strokeAlpha = (thinTape: boolean) => {
      const { surface, calls } = fakeSurface(1100, 640);
      drawBookmap(surface, model({ signals: [{ timeMs: 80_000, priceTicks: 107, kind: "Spoof", inferred: true, thinTape }] }));
      return calls.find((call) => call.method === "stroke" && call.strokeStyle === eventMarker("Spoof").color)?.globalAlpha;
    };

    expect([strokeAlpha(true), strokeAlpha(false)]).toEqual([THIN_TAPE_ALPHA, 1]);
  });
});

describe("drawBookmap in Light", () => {
  afterEach(() => canvasTheme.set("dark"));

  it("should paint the stage, the column heads and an event marker from the Light values when the theme is Light", () => {
    canvasTheme.set("light");
    const { surface, calls } = fakeSurface(1100, 640);

    drawBookmap(surface, model({ signals: [{ timeMs: 80_000, priceTicks: 107, kind: "Spoof", inferred: true }] }));

    expect(calls.find((call) => call.method === "fillRect")?.fillStyle).toBe(color("surface-lowest", "light"));
    expect(calls.find((call) => call.method === "fillText" && call.args[0] === "PRICE")?.fillStyle).toBe(color("on-surface-muted", "light"));
    expect(calls.some((call) => call.method === "stroke" && call.strokeStyle === color("event-spoof", "light"))).toBe(true);
    expect(calls.some((call) => call.fillStyle === color("surface-lowest") || call.strokeStyle === color("event-spoof"))).toBe(false);
  });
});

// D-40's last-price line on tokens: a dark line over a light halo in Light (the maintainer's ruling).
describe("drawBookmap price line in Light", () => {
  afterEach(() => canvasTheme.set("dark"));

  const steps = model({
    showCandles: false,
    showPriceLine: true,
    historyWatermarkMs: 60_000,
    priceSteps: [
      { timeMs: 0, priceTicks: 100 },
      { timeMs: 120_000, priceTicks: 110 },
    ],
  });

  /** The strokes in `theme`'s price-line colours (the line and both halos), in the order drawn. */
  function priceStrokes(calls: readonly CanvasCall[], theme: "dark" | "light"): unknown[] {
    const styles = ["price-line", "price-line-halo", "price-line-halo-warmup"].map((name) => color(name, theme));
    return calls.filter((call) => call.method === "stroke" && styles.includes(String(call.strokeStyle))).map((call) => call.strokeStyle);
  }

  it("should stroke a dark line over a light halo, and the warmup halo, from the Light values when the theme is Light", () => {
    canvasTheme.set("light");
    const { surface, calls } = fakeSurface(1100, 640);

    drawBookmap(surface, steps);

    expect(priceStrokes(calls, "light")).toEqual([color("price-line-halo-warmup", "light"), color("price-line-halo", "light"), color("price-line", "light")]);
    // Light swaps Terminal's line and halo, so only the warmup halo can tell a Terminal stroke apart.
    expect(calls.some((call) => call.method === "stroke" && call.strokeStyle === color("price-line-halo-warmup"))).toBe(false);
  });

  it("should stroke the light line over the dark halo, and the warmup halo, from the Terminal values when the theme is Terminal", () => {
    const { surface, calls } = fakeSurface(1100, 640);

    drawBookmap(surface, steps);

    expect(priceStrokes(calls, "dark")).toEqual(["#2a303a", "#140e08", "#f6f3ea"]);
  });
});
