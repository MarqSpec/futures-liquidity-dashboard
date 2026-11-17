import type { Surface } from "../lib/canvas.ts";

/** One recorded call on the fake 2D context. */
export interface CanvasCall {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly font: unknown;
  readonly lineWidth: unknown;
  readonly lineJoin: unknown;
  readonly globalAlpha: unknown;
}

/**
 * A stand-in 2D context that records every method call (with the fill, stroke, font, line width, line join and alpha
 * at the time), so drawing code runs in Node and a test can assert what was drawn without a browser. `save` and `restore` keep a
 * real state stack, as a browser does, so state one draw leaves behind is visible to the next.
 */
export function fakeSurface(width = 800, height = 400): { readonly surface: Surface; readonly calls: CanvasCall[] } {
  const calls: CanvasCall[] = [];
  const state: Record<string | symbol, unknown> = {
    fillStyle: "#000",
    strokeStyle: "#000",
    globalAlpha: 1,
    font: "10px sans-serif",
    lineWidth: 1,
    lineJoin: "miter",
  };
  const saved: Record<string | symbol, unknown>[] = [];
  const record = (key: string, args: unknown[]) => {
    calls.push({ method: key, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, font: state.font, lineWidth: state.lineWidth, lineJoin: state.lineJoin, globalAlpha: state.globalAlpha });
  };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text: string) => ({ width: text.length * 6 });
      if (key === "createPattern") return () => ({ pattern: true });
      if (key === "save") {
        return () => {
          record("save", []);
          saved.push({ ...target });
        };
      }
      if (key === "restore") {
        return () => {
          record("restore", []);
          const previous = saved.pop();
          if (previous) Object.assign(target, previous);
        };
      }
      return (...args: unknown[]) => record(String(key), args);
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  // The proxy implements the subset of CanvasRenderingContext2D the drawing modules use.
  return { surface: { ctx: ctx as unknown as CanvasRenderingContext2D, width, height }, calls };
}
