import type { LevelTouch, Overlay } from "../api/schemas.ts";
import { formatAge, formatChicagoTime, formatLocalTime, formatPercent, formatTicks, type TickSpec } from "../domain/format.ts";
import { touchOutcomeText } from "../domain/quote.ts";
import { useNow } from "../hooks/useNow.ts";
import { SidePanel, type SideFold } from "./SidePanel.tsx";

/** Props of the agent overlay panel. */
export interface OverlayPanelProps {
  readonly overlay: Overlay | null;
  readonly spec: TickSpec;
  readonly shown: boolean;
  readonly fold?: SideFold;
  /** The open product's own levels with their touch counts and outcomes (REQUIREMENTS.md FR-79). */
  readonly touches?: readonly LevelTouch[];
}

/** The open product's levels, highest first, each with its touch count and how those touches ended. */
function LevelTouches({ touches, spec }: { readonly touches: readonly LevelTouch[]; readonly spec: TickSpec }) {
  if (touches.length === 0) {
    return <p className="muted">No levels for this product yet.</p>;
  }
  return (
    <ul className="ld-list" aria-label="Level touches">
      {[...touches].sort((a, b) => b.priceTicks - a.priceTicks).map((level) => (
        <li key={`${level.name}-${level.priceTicks}`} className={`ld-level${level.isThirdTouch ? " ld-level-third" : ""}`}>
          <span className="kind">{level.name}</span>
          {formatTicks(level.priceTicks, spec)}
          <span className="ld-level-type">{touchOutcomeText(level)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The product's own levels with their touches (FR-79), then the agent's overlay: who published it, as of when,
 * whether it has expired, its levels and its rationale (plain text).
 */
export function OverlayPanel({ overlay, spec, shown, fold, touches = [] }: OverlayPanelProps) {
  const now = useNow(1000);
  if (!overlay) {
    return (
      <SidePanel label="Levels" title="Levels" fold={fold}>
        <LevelTouches touches={touches} spec={spec} />
        <p className="muted">No overlay has been published for this instrument.</p>
      </SidePanel>
    );
  }
  return (
    <SidePanel
      label="Levels"
      fold={fold}
      title={
        <>
          Levels
          <span className={overlay.expired ? "chip chip-bad" : "chip chip-replay"}>{overlay.expired ? "EXPIRED" : "CURRENT"}</span>
        </>
      }
    >
      <LevelTouches touches={touches} spec={spec} />
      {!shown && <p className="muted">Hidden on the chart.</p>}
      {overlay.levels.length === 0 ? (
        <p className="muted">The overlay has no levels.</p>
      ) : (
        <ul className="ld-list">
          {[...overlay.levels].sort((a, b) => b.priceTicks - a.priceTicks).map((level) => (
            <li
              key={`${level.priceTicks}-${level.label}`}
              className={`ld-level${level.kind === "support" || level.kind === "resistance" ? ` ld-level-${level.kind}` : ""}`}
            >
              <span className="kind">{level.label}</span>
              <span className="ld-level-type">{level.kind}</span>
              {formatTicks(level.priceTicks, spec)}
            </li>
          ))}
        </ul>
      )}
      <dl className="ld-metrics">
        <dt>Publisher</dt>
        <dd>{overlay.publisher}</dd>
        <dt>As of</dt>
        <dd>
          {formatLocalTime(overlay.asOfMs)} · {formatChicagoTime(overlay.asOfMs)}
        </dd>
        <dt>Expires</dt>
        <dd>
          {formatLocalTime(overlay.expiresAtMs)}{" "}
          <span className="muted">
            ({overlay.expiresAtMs > now ? `in ${formatAge(overlay.expiresAtMs - now)}` : `${formatAge(now - overlay.expiresAtMs)} ago`})
          </span>
        </dd>
        <dt>Coverage</dt>
        <dd>{formatPercent(overlay.sourceCoverage)}</dd>
        <dt>Version</dt>
        <dd>{overlay.version}</dd>
      </dl>
      {overlay.qualityFlags.length > 0 && <p className="small-text warn-text">Quality: {overlay.qualityFlags.join(", ")}</p>}
      <p className="rationale">{overlay.rationale}</p>
    </SidePanel>
  );
}
