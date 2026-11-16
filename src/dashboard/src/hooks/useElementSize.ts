import { useEffect, useState, type RefObject } from "react";

/**
 * Long edge of an 8K display, in CSS pixels. A measured element larger than a real display is a layout bug: a CSS
 * feedback loop once grew a chart canvas to about 1.5 million pixels.
 */
export const MAX_DEVICE_EDGE_PX = 8192;

/** How many viewports of a pane are still a layout, rather than a runaway measurement. */
const VIEWPORT_MULTIPLE = 4;

/** Caps a measured content box so a canvas cannot grow without limit. */
export function clampElementSize(
  width: number,
  height: number,
  viewport: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  return {
    width: clampEdge(width, edgeLimit(viewport.width)),
    height: clampEdge(height, edgeLimit(viewport.height)),
  };
}

function edgeLimit(viewportEdge: number): number {
  if (!Number.isFinite(viewportEdge) || viewportEdge <= 0) {
    return MAX_DEVICE_EDGE_PX;
  }
  return Math.min(MAX_DEVICE_EDGE_PX, Math.floor(viewportEdge) * VIEWPORT_MULTIPLE);
}

function clampEdge(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), max);
}

function viewportSize(): { readonly width: number; readonly height: number } {
  const width = globalThis.innerWidth;
  const height = globalThis.innerHeight;
  return {
    width: typeof width === "number" ? width : 0,
    height: typeof height === "number" ? height : 0,
  };
}

/** The element's content size in CSS pixels, kept current with a ResizeObserver and capped at a real display. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { readonly width: number; readonly height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) {
        return;
      }
      const next = clampElementSize(box.width, box.height, viewportSize());
      setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
