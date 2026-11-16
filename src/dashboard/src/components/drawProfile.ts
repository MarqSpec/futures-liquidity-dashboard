import type { Profile } from "../api/schemas.ts";
import { withAlpha } from "../design/color.ts";
import { formatTicks, type TickSpec } from "../domain/format.ts";
import { linearScale } from "../domain/scale.ts";
import { labelBox, type Surface } from "../lib/canvas.ts";
import { canvasColors, colors, fonts, themed } from "../theme.ts";

// Alpha variants of the tokens, built once per theme.
const tints = themed((theme) => {
  const c = canvasColors(theme);
  return {
    valueBin: withAlpha(c.value, 0.75),
    otherBin: withAlpha(c.reference, 0.55),
  };
});

/** Draws a volume profile: bins (POC, value area, the rest), the VAH/VAL/POC rules, node marks and the last price. */
export function drawProfile(surface: Surface, profile: Profile, spec: TickSpec, lastTicks: number | null): void {
  const { ctx, width, height } = surface;
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  if (profile.bins.length === 0) {
    ctx.fillStyle = colors.muted;
    ctx.font = fonts.sm;
    ctx.fillText("no volume yet", 8, 16);
    return;
  }
  const low = profile.bins[0]?.[0] ?? 0;
  const high = profile.bins.at(-1)?.[0] ?? 0;
  const labelWidth = 64;
  const y = linearScale(low - 0.5, high + 0.5, height - 4, 4);
  const max = Math.max(1, ...profile.bins.map((b) => b[1]));
  const x = linearScale(0, max, labelWidth, width - 4);
  const rowHeight = Math.max(1, Math.abs(y.toPx(0) - y.toPx(1)));
  const inValue = (p: number) => profile.val != null && profile.vah != null && p >= profile.val && p <= profile.vah;
  for (const [p, v] of profile.bins) {
    ctx.fillStyle = p === profile.poc ? colors.poc : inValue(p) ? tints.valueBin : tints.otherBin;
    ctx.fillRect(labelWidth, y.toPx(p + 0.5), Math.max(1, x.toPx(v) - labelWidth), Math.max(1, rowHeight - (rowHeight > 3 ? 0.5 : 0)));
  }
  ctx.font = fonts.xs;
  const line = (p: number | null | undefined, color: string, text: string, dash: number[]) => {
    if (p === null || p === undefined) return;
    const py = Math.round(y.toPx(p)) + 0.5;
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(labelWidth, py);
    ctx.lineTo(width, py);
    ctx.stroke();
    ctx.setLineDash([]);
    labelBox(ctx, `${text} ${formatTicks(p, spec)}`, 0, py, { fill: colors.scrim, color });
  };
  line(profile.vah, colors.value, "VAH", [4, 3]);
  line(profile.val, colors.value, "VAL", [4, 3]);
  line(profile.poc, colors.poc, "POC", []);
  // Volume nodes are levels, not price directions.
  for (const p of profile.hvn) {
    ctx.fillStyle = colors.nodeHvn;
    ctx.fillText("▶", labelWidth - 10, y.toPx(p));
  }
  for (const p of profile.lvn) {
    ctx.fillStyle = colors.nodeLvn;
    ctx.fillText("▷", labelWidth - 10, y.toPx(p));
  }
  if (lastTicks !== null && lastTicks >= low && lastTicks <= high) {
    const py = Math.round(y.toPx(lastTicks)) + 0.5;
    ctx.strokeStyle = colors.lastPrice;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(labelWidth, py);
    ctx.lineTo(width, py);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
