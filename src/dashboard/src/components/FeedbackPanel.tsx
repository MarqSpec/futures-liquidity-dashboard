import { advisoryText, citedValues, ghostKey, legName, noFeedbackText, staleText, type FeedbackGhost, type PlanFeedbackReply, type StaleReason } from "../domain/feedback.ts";
import { formatChicagoTime, formatTicks, type TickSpec } from "../domain/format.ts";
import type { FeedbackPanelState } from "../hooks/useFeedback.ts";

// The feedback panel beside the chart (REQUIREMENTS.md FR-74, NFR-8): a summary, then a section per leg with its fill likelihood
// as text, its assessment, its suggestion and the cited metrics with their values, then the risks. Advisory only.

export interface FeedbackPanelProps {
  readonly state: FeedbackPanelState;
  readonly spec: TickSpec;
  readonly ghosts: readonly FeedbackGhost[];
  readonly onApply: (ghost: FeedbackGhost) => void;
  readonly onClose: () => void;
}

interface LegRef {
  readonly leg: "entry" | "stop" | "target";
  readonly index?: number | null;
}

function Cites({ names, reply, leg, spec }: { readonly names: readonly string[]; readonly reply: PlanFeedbackReply; readonly leg: LegRef | null; readonly spec: TickSpec }) {
  const values = citedValues(names, reply.metrics, leg, spec);
  return (
    <p className="feedback-cites">
      <span>cites: </span>
      {values.map((cited, index) => (
        // A model may cite one name twice.
        // oxlint-disable-next-line react/no-array-index-key
        <span key={`${index}-${cited.name}`} className="feedback-cite">
          {cited.name} <b>{cited.value}</b>
          {index < values.length - 1 ? "; " : ""}
        </span>
      ))}
    </p>
  );
}

function Header({ reply, stale, onClose }: { readonly reply: PlanFeedbackReply | null; readonly stale: StaleReason | null; readonly onClose: () => void }) {
  return (
    <header className="feedback-head">
      <h3>Feedback</h3>
      {reply && <span className="feedback-asof">{`as of ${formatChicagoTime(reply.feedback?.asOfMs ?? reply.metrics.asOfMs)}`}</span>}
      <button type="button" className="feedback-close" onClick={onClose}>
        Close
      </button>
      {stale && (
        <output className="feedback-stale">
          {staleText[stale]}
        </output>
      )}
    </header>
  );
}

function Body({ state, spec, ghosts, onApply, onClose }: FeedbackPanelProps) {
  switch (state.kind) {
    case "loading":
      return (
        <>
          <Header reply={null} stale={null} onClose={onClose} />
          <output className="feedback-state">
            Asking for feedback…
          </output>
        </>
      );
    case "over-budget":
      return (
        <>
          <Header reply={null} stale={null} onClose={onClose} />
          <output className="feedback-state">
            {`Over budget: $${state.status.spentUsd.toFixed(2)} spent of the $${state.status.budgetUsd.toFixed(2)} cap for ${state.status.month}. Feedback resumes ${new Date(state.status.resetsAtMs).toISOString().slice(0, 10)} (UTC).`}
          </output>
        </>
      );
    case "rate-limited":
      return (
        <>
          <Header reply={null} stale={null} onClose={onClose} />
          <output className="feedback-state">
            {state.reason === "request-in-flight"
              ? "A feedback request is already running for you. Wait for it to finish."
              : `Rate limited: too many requests this minute.${state.retryAfterSeconds ? ` Try again in ${state.retryAfterSeconds} s.` : ""}`}
          </output>
        </>
      );
    case "failed":
      return (
        <>
          <Header reply={null} stale={null} onClose={onClose} />
          <p className="feedback-state" role="alert">
            {state.message}
          </p>
        </>
      );
    case "metrics-only":
      return (
        <>
          <Header reply={state.reply} stale={state.stale} onClose={onClose} />
          <output className="feedback-state">{`Metrics only: ${noFeedbackText[state.reason] ?? state.reason}.`}</output>
          <ul className="feedback-metrics">
            <li>{`Last ${formatTicks(state.reply.metrics.lastTicks, spec)}${state.reply.metrics.atrTicks == null ? "" : `, ATR ${state.reply.metrics.atrTicks.toFixed(1)} ticks`}`}</li>
            {state.reply.metrics.legs.map((leg) => (
              <li key={legName(leg)}>{`${legName(leg)} ${formatTicks(leg.priceTicks, spec)}: ${leg.distanceTicks == null ? "distance unknown" : `${leg.distanceTicks} ticks from last`}`}</li>
            ))}
          </ul>
        </>
      );
    case "answered": {
      const feedback = state.reply.feedback;
      if (!feedback) return null;
      return (
        <>
          <Header reply={state.reply} stale={state.stale} onClose={onClose} />
          <p className="feedback-summary">{feedback.summary}</p>
          {feedback.legs.map((leg) => {
            const ghost = ghosts.find((item) => item.key === ghostKey(leg));
            const name = legName(leg);
            const price = leg.suggestion ? formatTicks(leg.suggestion.priceTicks, spec) : "";
            return (
              <section key={name} className="feedback-leg" aria-label={`Feedback on the ${name}`}>
                <h4>
                  {name.charAt(0).toUpperCase() + name.slice(1)}{" "}
                  <span className="feedback-pill" data-likelihood={leg.fillLikelihood}>
                    {`Fill likelihood: ${leg.fillLikelihood}`}
                  </span>
                </h4>
                <p>{leg.assessment}</p>
                {leg.suggestion && (
                  <p className="feedback-suggestion">
                    {`→ ${price}, ${leg.suggestion.why} `}
                    <button type="button" disabled={state.stale !== null || !ghost} aria-label={`Apply the suggested ${name} ${price}`} onClick={() => ghost && onApply(ghost)}>
                      Apply
                    </button>
                  </p>
                )}
                <Cites names={leg.cites} reply={state.reply} leg={leg} spec={spec} />
              </section>
            );
          })}
          {feedback.risks.length > 0 && (
            <section className="feedback-risks" aria-label="Risks">
              <h4>Risks</h4>
              <ul>
                {feedback.risks.map((risk, index) => (
                  // A model may repeat a risk.
                  // oxlint-disable-next-line react/no-array-index-key
                  <li key={`${index}-${risk.text}`}>
                    {risk.text}
                    <Cites names={risk.cites} reply={state.reply} leg={null} spec={spec} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {feedback.droppedCites > 0 && (
            <p className="feedback-removed">{`${feedback.droppedCites} ${feedback.droppedCites === 1 ? "claim" : "claims"} removed: the server dropped what it could not ground in the metrics.`}</p>
          )}
        </>
      );
    }
  }
}

/** Feedback on the simulated position, or the state that stands in for it. The advisory label is always on it. */
export function FeedbackPanel(props: FeedbackPanelProps) {
  const provider = "reply" in props.state ? props.state.reply.provider : null;
  return (
    <aside className="feedback-dock" aria-label="Position feedback">
      <div className="feedback-scroll">
        {/* A scrolling region is reached with Tab in every browser only when it takes focus itself. */}
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <section className="feedback-panel" tabIndex={0} aria-label="Feedback answer">
          <Body {...props} />
        </section>
      </div>
      {/* Outside the scrolling region, so the advisory label and MOCK are in view with whatever is scrolled to. */}
      <footer className="feedback-foot">
        {provider === "mock" && (
          <span className="feedback-mock" title="Deterministic mock feedback written from the metrics, not by Claude">
            MOCK
          </span>
        )}
        <p className="feedback-advisory" role="note">
          {advisoryText}
        </p>
      </footer>
    </aside>
  );
}
