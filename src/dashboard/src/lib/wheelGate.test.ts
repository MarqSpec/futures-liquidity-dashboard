// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWheelGate, plotWhollyInView, WHEEL_GESTURE_PAUSE_MS, type PlotBox, type WheelGate } from "./wheelGate.ts";


const plot: PlotBox = { x: 10, y: 20, w: 300, h: 200 };

function place(element: Element, left: number, top: number, width = 400, height = 300): void {
  vi.spyOn(element, "getBoundingClientRect").mockImplementation(
    () => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) }) as DOMRect,
  );
}

function mount(): { chart: HTMLDivElement; container: HTMLDivElement } {
  const container = document.createElement("div");
  const chart = document.createElement("div");
  container.append(chart);
  document.body.append(container);
  return { chart, container };
}

function wheelAt(target: EventTarget, timeStamp: number, cancel: boolean): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  if (cancel) target.addEventListener("wheel", (e) => e.preventDefault(), { once: true });
  target.dispatchEvent(event);
  return event;
}

let gate: WheelGate | null = null;

afterEach(() => {
  gate?.dispose();
  gate = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("plotWhollyInView", () => {
  it("should say in view when every edge of the plot is inside the viewport", () => {
    const { chart } = mount();
    place(chart, 0, window.innerHeight - plot.y - plot.h);

    expect(plotWhollyInView(chart, plot)).toBe(true);
  });

  it.each([
    ["the bottom of the viewport", 0, window.innerHeight - plot.y - plot.h + 2],
    ["the top of the viewport", 0, -plot.y - 2],
    ["the left of the viewport", -plot.x - 2, 0],
    ["the right of the viewport", window.innerWidth - plot.x - plot.w + 2, 0],
  ])("should say not in view when the plot is cut off by %s", (_edge, left, top) => {
    const { chart } = mount();
    place(chart, left, top);

    expect(plotWhollyInView(chart, plot)).toBe(false);
  });

  it.each([
    ["the root element is overflow hidden", "documentElement"],
    ["the body is overflow hidden and the root element left visible", "body"],
  ] as const)("should ignore the viewport's edges when %s, so the page cannot scroll", (_name, owner) => {
    const { chart } = mount();
    document[owner].style.overflow = "hidden";
    place(chart, 0, window.innerHeight - plot.y - plot.h + 50);

    expect(plotWhollyInView(chart, plot)).toBe(true);
    document[owner].style.overflow = "";
  });

  it("should still count the viewport when the root element scrolls and only the body is hidden", () => {
    const { chart } = mount();
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "hidden";
    place(chart, 0, window.innerHeight - plot.y - plot.h + 50);

    expect(plotWhollyInView(chart, plot)).toBe(false);
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  });

  it("should allow a sub-pixel overhang from layout rounding", () => {
    const { chart } = mount();
    place(chart, 0, window.innerHeight - plot.y - plot.h + 0.5);

    expect(plotWhollyInView(chart, plot)).toBe(true);
  });

  it.each(["auto", "scroll"])("should say not in view when an overflow:%s container cuts the plot off", (overflow) => {
    const { chart, container } = mount();
    container.style.overflowY = overflow;
    place(container, 0, 0, 400, 150);
    place(chart, 0, 0);

    expect(plotWhollyInView(chart, plot)).toBe(false);
  });

  it.each(["hidden", "visible"])("should ignore an overflow:%s ancestor, which the wheel cannot scroll", (overflow) => {
    const { chart, container } = mount();
    container.style.overflowY = overflow;
    place(container, 0, 0, 400, 150);
    place(chart, 0, 0);

    expect(plotWhollyInView(chart, plot)).toBe(true);
  });

  it("should ignore the body and the root element, whose overflow is the viewport's", () => {
    const { chart } = mount();
    document.body.style.overflowY = "auto";
    document.documentElement.style.overflowY = "auto";
    place(document.body, 0, -5_000, 400, 100);
    place(document.documentElement, 0, -5_000, 400, 100);
    place(chart, 0, 0);

    expect(plotWhollyInView(chart, plot)).toBe(true);
    document.body.style.overflowY = "";
    document.documentElement.style.overflowY = "";
  });
});

describe("createWheelGate", () => {
  it("should let the chart take the wheel when its plot is in view and nothing has scrolled", () => {
    const { chart } = mount();
    place(chart, 0, 0);
    gate = createWheelGate(window);

    const event = new WheelEvent("wheel", { deltaY: 40 });
    Object.defineProperty(event, "timeStamp", { value: 1_000 });

    expect(gate.takesWheel(event, chart, plot)).toBe(true);
  });

  it("should refuse the wheel when the plot is cut off", () => {
    const { chart } = mount();
    place(chart, 0, window.innerHeight - 50);
    gate = createWheelGate(window);

    const event = new WheelEvent("wheel", { deltaY: 40 });
    Object.defineProperty(event, "timeStamp", { value: 1_000 });

    expect(gate.takesWheel(event, chart, plot)).toBe(false);
  });

  it("should refuse the wheel until it pauses after one that scrolled the page, even over a plot in view", () => {
    const { chart } = mount();
    place(chart, 0, 0);
    gate = createWheelGate(window);

    wheelAt(document.body, 1_000, false);
    const during = new WheelEvent("wheel");
    Object.defineProperty(during, "timeStamp", { value: 1_000 + WHEEL_GESTURE_PAUSE_MS - 1 });
    const after = new WheelEvent("wheel");
    Object.defineProperty(after, "timeStamp", { value: 1_000 + WHEEL_GESTURE_PAUSE_MS });

    expect(gate.takesWheel(during, chart, plot)).toBe(false);
    expect(gate.takesWheel(after, chart, plot)).toBe(true);
  });

  it("should not count a wheel a chart cancelled as a page scroll", () => {
    const { chart } = mount();
    place(chart, 0, 0);
    gate = createWheelGate(window);

    wheelAt(chart, 1_000, true);
    const next = new WheelEvent("wheel");
    Object.defineProperty(next, "timeStamp", { value: 1_010 });

    expect(gate.takesWheel(next, chart, plot)).toBe(true);
  });

  it("should stop watching the window once disposed", () => {
    const { chart } = mount();
    place(chart, 0, 0);
    gate = createWheelGate(window);
    gate.dispose();

    wheelAt(document.body, 1_000, false);
    const next = new WheelEvent("wheel");
    Object.defineProperty(next, "timeStamp", { value: 1_010 });

    expect(gate.takesWheel(next, chart, plot)).toBe(true);
  });
});
