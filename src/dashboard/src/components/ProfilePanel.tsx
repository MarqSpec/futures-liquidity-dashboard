import { useEffect, useRef } from "react";

import type { Profile } from "../api/schemas.ts";
import { formatLocalMinute, formatPercent, formatQty, formatTicks, type TickSpec } from "../domain/format.ts";
import { useCanvasFontEpoch } from "../hooks/useCanvasFontEpoch.ts";
import { useCanvasPalette } from "../hooks/useCanvasTheme.ts";
import { useElementSize } from "../hooks/useElementSize.ts";
import { prepareSurface } from "../lib/canvas.ts";
import { drawProfile } from "./drawProfile.ts";
import { SidePanel, type SideFold } from "./SidePanel.tsx";

/** Props of the volume profile panel. */
export interface ProfilePanelProps {
  readonly profiles: readonly Profile[];
  /** The windows the layout shows ("session", "1h", "4h"). */
  readonly windows: readonly string[];
  readonly selected: string;
  readonly onSelect: (window: string) => void;
  readonly spec: TickSpec;
  readonly lastTicks: number | null;
  readonly fold?: SideFold;
}

/** The volume profile of the chosen window with POC, value area and high/low-volume nodes. */
export function ProfilePanel({ profiles, windows, selected, onSelect, spec, lastTicks, fold }: ProfilePanelProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width, height } = useElementSize(wrapRef);
  // Read so the panel re-renders, and redraws, once the canvas fonts load and when the theme or a chart colour changes.
  useCanvasFontEpoch();
  useCanvasPalette();
  const profile = profiles.find((p) => p.window === selected) ?? null;

  useEffect(() => {
    const surface = prepareSurface(canvasRef.current, width, height);
    if (profile && surface) drawProfile(surface, profile, spec, lastTicks);
  });

  return (
    <SidePanel
      label="Volume profile"
      className="profile"
      title="Profile"
      fold={fold}
      headControl={
        <fieldset className="segmented small">
          <legend className="visually-hidden">Profile window</legend>
          {windows.map((w) => (
            <button key={w} type="button" aria-pressed={w === selected} onClick={() => onSelect(w)}>
              {w}
            </button>
          ))}
        </fieldset>
      }
    >
      <p className="muted small-text">
        {profile
          ? `vol ${formatQty(profile.total)} · VA ${formatPercent(profile.vaFraction ?? null)}${
              profile.partialSinceMs != null ? ` · partial since ${formatLocalMinute(profile.partialSinceMs)}` : ""
            }${
              profile.missingRanges.length > 0
                ? ` · ${profile.missingRanges.length} missing ${profile.missingRanges.length === 1 ? "range" : "ranges"}`
                : ""
            }${
              profile.approximateRanges.length > 0
                ? ` · ${profile.approximateRanges.length} approximate ${profile.approximateRanges.length === 1 ? "range" : "ranges"}`
                : ""
            }`
          : windows.length === 0
            ? "Every profile window is hidden."
            : "No profile for this window."}
      </p>
      <div className="pane-canvas" ref={wrapRef}>
        {profile && (
          <>
            <p className="visually-hidden">
              {`${selected} volume profile: POC ${formatTicks(profile.poc, spec)}, value area ${formatTicks(profile.val, spec)} to ${formatTicks(profile.vah, spec)}`}
            </p>
            <canvas ref={canvasRef} aria-hidden="true" style={{ width, height }} />
          </>
        )}
      </div>
    </SidePanel>
  );
}
