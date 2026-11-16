import type { StreamView } from "../api/marketStream.ts";
import type { InstrumentSummary } from "../api/schemas.ts";
import { formatAge, formatChicagoMinute } from "../domain/format.ts";
import { lastPriceText, sessionChange } from "../domain/quote.ts";
import { regimeFor, regimeTimeframes } from "../domain/regime.ts";
import { useNow } from "../hooks/useNow.ts";
import { ChangeServerButton } from "./ChangeServerButton.tsx";
import { chipTone } from "../domain/status.ts";
import { RegimeBadge } from "./RegimeBadge.tsx";

/** Props of the status bar. */
export interface StatusBarProps {
  readonly view: StreamView;
  readonly instrument: string;
  readonly instruments: readonly InstrumentSummary[];
}

/**
 * The selected instrument (chosen in the product picker below), its contract and its 5- and 15-minute regimes
 * (from the polled summary), the last price and session change, the status chip with its provenance always beside
 * it (simulated data never looks live), the age of the last event, seq and resyncs. The session, hub state and
 * clock live in the top bar; the chart controls are `ChartToolbar`, under this bar.
 */
export function StatusBar(props: StatusBarProps) {
  const { view, instrument, instruments } = props;
  const now = useNow(500);
  const market = view.market?.root === instrument ? view.market : null;
  const listed = instruments.find((i) => i.instrument.root === instrument) ?? null;
  const info = market?.instrument ?? listed?.instrument ?? null;
  const status = market?.status ?? null;
  const code = view.hub !== "connected" ? "DISCONNECTED" : (status?.code ?? "WAITING");
  const provenance = status?.provenance ?? "UNKNOWN";
  const spec = info ?? { tickSize: 0.25, priceDecimals: 2 };
  const change = listed?.changeTicks ?? null;
  const changeTone = change == null || change === 0 ? "" : change > 0 ? "up" : "down";
  const ageMs =
    market && status?.lastEventAgeMs !== null && status?.lastEventAgeMs !== undefined
      ? status.lastEventAgeMs + Math.max(0, now - market.receivedAtMs)
      : null;

  return (
    <header className="status-bar">
      <div className="instrument">
        <strong>
          {instrument} <span className="muted">{info?.name ?? ""}</span>
        </strong>
        <span className="muted">
          {info ? `${info.contractId} · ${info.exchange} · exp ${info.expiry}` : "loading contract…"}
        </span>
      </div>
      <span className="last-price">
        <span className="visually-hidden">Last price </span>
        {lastPriceText(listed?.lastTicks, spec)}
      </span>
      <span className="stat">
        Chg{" "}
        <strong className={changeTone}>
          {sessionChange(change, spec.tickSize, spec.priceDecimals)}
          {change != null && change !== 0 ? (change > 0 ? " ▲" : " ▼") : ""}
        </strong>
      </span>
      {info && (
        <span className="stat regimes" aria-label="Regime">
          {regimeTimeframes.map((seconds) => (
            <RegimeBadge
              key={seconds}
              regime={listed ? regimeFor(listed.summary, seconds) : null}
              timeframeSeconds={seconds}
              spec={info}
            />
          ))}
        </span>
      )}
      {status?.missingSinceMs != null && (
        <output className="chip chip-degraded">
          data missing since {formatChicagoMinute(status.missingSinceMs)} CT
        </output>
      )}
      {status?.approximate && (
        <output className="chip chip-degraded">approximate history</output>
      )}
      <output className={`chip chip-${code === "WAITING" ? "bad" : chipTone(code)}`} aria-label={`Feed status ${code}`}>
        {code}
      </output>
      <output className={`chip chip-outline chip-${chipTone(provenance)}`} aria-label={`Data provenance ${provenance}`}>
        {provenance === "SIMULATED" ? "SIMULATED DATA" : provenance}
      </output>
      {view.awaitingSnapshot && <span className="stat muted">loading snapshot…</span>}
      {view.error && (
        <span className="stat error" role="alert">
          {view.error}
        </span>
      )}
      <div className="spacer" />
      <span className="feed-line" title="Age of the last event, sequence and resyncs">
        last event {formatAge(ageMs)} · seq {market?.seq ?? "—"} · resyncs {view.resyncs}
      </span>
      <ChangeServerButton />
    </header>
  );
}
