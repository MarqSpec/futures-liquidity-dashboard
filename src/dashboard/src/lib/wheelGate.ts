// reference: ARCHITECTURE.md D-53

/**
 * A wheel gesture that scrolled the page keeps scrolling it until no wheel event has scrolled anything for this
 * long, so momentum does not start zooming the moment a chart arrives wholly in view (REQUIREMENTS.md FR-67, FR-68).
 */
export const WHEEL_GESTURE_PAUSE_MS = 250;

/** A chart's plot, in CSS pixels from the top-left of the element its wheel listener is on. */
export interface PlotBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Layout rounds edges to fractions of a pixel; a plot this close to an edge is still in view. */
const EDGE_SLACK_PX = 1;

const SCROLLS = new Set(["auto", "scroll", "overlay"]);

/** Viewport overflow values that stop the page scrolling. */
const PINNED = new Set(["hidden", "clip"]);

function overflowOf(style: CSSStyleDeclaration): readonly [string, string] {
  return [style.overflowX || style.overflow, style.overflowY || style.overflow];
}

/**
 * True when the page itself can scroll. The viewport takes the root element's overflow, or the body's when the root
 * leaves it `visible` (CSS Overflow 3, overflow propagation).
 */
function viewportScrolls(document: Document, view: Window): boolean {
  const root = overflowOf(view.getComputedStyle(document.documentElement));
  const visible = root.every((value) => value === "" || value === "visible");
  const owner = visible ? overflowOf(view.getComputedStyle(document.body)) : root;
  return owner.some((value) => !PINNED.has(value));
}

/**
 * True when every edge of `plot` is inside each box the wheel could scroll it out of: the viewport while the page
 * can scroll, and each ancestor the wheel can scroll. A box that clips without scrolling (`overflow: hidden`, on an
 * ancestor or on the page) is not counted: letting the wheel through would not bring the plot out of it, only stop
 * the chart zooming.
 */
export function plotWhollyInView(element: Element, plot: PlotBox): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  const rect = element.getBoundingClientRect();
  const left = rect.left + plot.x;
  const top = rect.top + plot.y;
  const right = left + plot.w;
  const bottom = top + plot.h;
  const inside = (l: number, t: number, r: number, b: number) =>
    left >= l - EDGE_SLACK_PX && top >= t - EDGE_SLACK_PX && right <= r + EDGE_SLACK_PX && bottom <= b + EDGE_SLACK_PX;
  const { body, documentElement } = element.ownerDocument;
  if (viewportScrolls(element.ownerDocument, view) && !inside(0, 0, view.innerWidth, view.innerHeight)) return false;
  for (let node = element.parentElement; node; node = node.parentElement) {
    // Their overflow can be the viewport's, handled above; their own box can be taller than the viewport.
    if (node === body || node === documentElement) continue;
    const style = view.getComputedStyle(node);
    if (!SCROLLS.has(style.overflowX) && !SCROLLS.has(style.overflowY)) continue;
    const box = node.getBoundingClientRect();
    if (!inside(box.left, box.top, box.right, box.bottom)) return false;
  }
  return true;
}

/** Decides, per wheel event, whether a chart may zoom or must leave the wheel to scroll the page. */
export interface WheelGate {
  /**
   * True when the chart may take `event`: its plot is wholly in view and no page-scroll gesture is running. When
   * false the chart must not call `preventDefault`, so the page scrolls instead.
   */
  readonly takesWheel: (event: WheelEvent, element: Element, plot: PlotBox) => boolean;
  /** Stops watching the window's wheel events. */
  readonly dispose: () => void;
}

/**
 * Watches every wheel event that reaches `view`. One no chart cancelled is taken as a page scroll, and until the wheel
 * pauses for {@link WHEEL_GESTURE_PAUSE_MS} the gate keeps the gesture scrolling. That includes a wheel that moved
 * nothing (a notch at the span limit, or over a strip no chart zooms on): the next notch zooms only after the pause.
 * Time is the events' own `timeStamp`.
 */
export function createWheelGate(view: Window): WheelGate {
  let scrolledAt = Number.NEGATIVE_INFINITY;
  const watch = (event: WheelEvent) => {
    if (!event.defaultPrevented) scrolledAt = event.timeStamp;
  };
  view.addEventListener("wheel", watch, { passive: true });
  return {
    takesWheel: (event, element, plot) => event.timeStamp - scrolledAt >= WHEEL_GESTURE_PAUSE_MS && plotWhollyInView(element, plot),
    dispose: () => view.removeEventListener("wheel", watch),
  };
}
