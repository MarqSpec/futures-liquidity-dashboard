import { useCallback, useEffect, useRef } from "react";

import { createWheelGate, plotWhollyInView, type PlotBox, type WheelGate } from "../lib/wheelGate.ts";

/**
 * One wheel gate for the life of a chart, so a re-render does not forget a page-scroll gesture that is running. The
 * returned function is stable; the Detail and Order Flow wheel handlers both call it before they zoom (D-53).
 */
export function useWheelGate(): (event: WheelEvent, element: Element, plot: PlotBox) => boolean {
  const gate = useRef<WheelGate | null>(null);
  useEffect(() => {
    const created = createWheelGate(window);
    gate.current = created;
    return () => {
      created.dispose();
      gate.current = null;
    };
  }, []);
  return useCallback((event, element, plot) => gate.current?.takesWheel(event, element, plot) ?? plotWhollyInView(element, plot), []);
}
