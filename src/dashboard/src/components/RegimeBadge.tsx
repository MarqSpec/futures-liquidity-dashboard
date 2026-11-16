import type { Regime } from "../api/schemas.ts";
import type { TickSpec } from "../domain/format.ts";
import { hints } from "../domain/hints.ts";
import { regimeLabel, regimeTitle, regimeTone, timeframeLabel } from "../domain/regime.ts";
import { Hint } from "./Hint.tsx";

/** Props of a regime badge. */
export interface RegimeBadgeProps {
  readonly regime: Regime | null;
  readonly timeframeSeconds: number;
  readonly spec: TickSpec;
}

/**
 * One timeframe's regime as a short coloured label ("5m Trend ↑"). Its hint says what the label means and, after it,
 * the inputs and since when (REQUIREMENTS.md UC-14). The label takes keyboard focus so the hint is reachable without a pointer.
 */
export function RegimeBadge({ regime, timeframeSeconds, spec }: RegimeBadgeProps) {
  const text = `${timeframeSeconds === 900 ? hints.regime15m : hints.regime5m} ${regimeTitle(regime, spec)}`;
  return (
    <Hint label={`${timeframeLabel(timeframeSeconds)} regime`} text={text}>
      {(hint) => (
        // A label with nothing to press is focusable on purpose: the hint is for a keyboard user too.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <span className={`regime regime-${regimeTone(regime)}`} tabIndex={0} {...hint}>
          <span className="muted">{timeframeLabel(timeframeSeconds)}</span> {regimeLabel(regime)}
        </span>
      )}
    </Hint>
  );
}
