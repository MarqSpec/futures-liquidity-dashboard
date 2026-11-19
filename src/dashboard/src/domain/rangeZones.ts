import type { RangeZone, RangeZoneSet } from "../api/schemas.ts";
import { isPaneOn, type LayoutSettings } from "./layout.ts";

// reference: REQUIREMENTS.md FR-75 (ARCHITECTURE.md D-62)

/**
 * The range zones the price charts shade: the server's zones for the layout's `rangeZoneTimeframe`, or none when that
 * is `off` or the Layers toggle "Range zones" is off. The client never classifies a regime itself.
 */
export function rangeZonesFor(sets: readonly RangeZoneSet[], layout: LayoutSettings): readonly RangeZone[] {
  if (layout.rangeZoneTimeframe === "off" || !isPaneOn(layout, "range-zones")) return [];
  const seconds = Number(layout.rangeZoneTimeframe);
  return sets.find((set) => set.timeframeSeconds === seconds)?.zones ?? [];
}
