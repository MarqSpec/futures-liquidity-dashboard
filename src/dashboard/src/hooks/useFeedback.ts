import { useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client.ts";
import { FeedbackRefusedError, getFeedbackStatus, requestFeedback } from "../api/feedbackClient.ts";
import {
  feedbackOffered,
  staleReason,
  suggestionGhosts,
  type FeedbackGhost,
  type FeedbackStatus,
  type PlanFeedbackReply,
  type StaleReason,
} from "../domain/feedback.ts";
import type { TickSpec } from "../domain/format.ts";
import type { Position } from "../domain/position.ts";
import { moveLine, type PositionEdit } from "../domain/positionEdit.ts";

// Position feedback for the product on show (REQUIREMENTS.md FR-74, UC-20). It asks the server only when the Feedback button is
// pressed, once per press, and never refreshes: a reply goes stale instead (D-61). Hidden until the status says it exists.

/** What the feedback panel shows. */
export type FeedbackPanelState =
  | { readonly kind: "loading" }
  | { readonly kind: "answered"; readonly reply: PlanFeedbackReply; readonly stale: StaleReason | null }
  | { readonly kind: "metrics-only"; readonly reply: PlanFeedbackReply; readonly reason: string; readonly stale: StaleReason | null }
  | { readonly kind: "over-budget"; readonly status: FeedbackStatus }
  | { readonly kind: "rate-limited"; readonly reason: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: "failed"; readonly message: string };

type Held =
  | { readonly kind: "loading" }
  | { readonly kind: "reply"; readonly reply: PlanFeedbackReply; readonly requested: Position }
  | { readonly kind: "over-budget"; readonly status: FeedbackStatus }
  | { readonly kind: "rate-limited"; readonly reason: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: "failed"; readonly message: string };

export interface PositionFeedback {
  /** The Feedback button exists at all. False until the status says feedback is available (or only the budget is spent). */
  readonly offered: boolean;
  /** A request is in flight: the button is disabled. */
  readonly busy: boolean;
  readonly request: () => void;
  readonly close: () => void;
  /** Null until feedback is asked for. */
  readonly panel: FeedbackPanelState | null;
  /** The reply's provider, for the MOCK label. */
  readonly provider: PlanFeedbackReply["provider"] | null;
  /** Suggestions drawn on the chart: only while the feedback still describes the position. */
  readonly ghosts: readonly FeedbackGhost[];
  /** Applies a suggestion through the position edit path, so FR-72 can refuse it with the reason. */
  readonly applyGhost: (ghost: FeedbackGhost) => void;
}

export interface FeedbackInput {
  readonly root: string;
  readonly position: Position | null;
  readonly lastTicks: number | null;
  readonly spec: TickSpec;
  readonly apply: (edit: PositionEdit) => void;
}

function failureText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.failure === "timeout") return "Feedback did not answer in time. Try again.";
    if (error.failure === "invalid") return "The server refused this position for feedback.";
    if (error.failure === "forbidden") return "This key may not ask for feedback.";
    if (error.failure === "bad-response") return "The server's answer was not in the expected shape.";
  }
  return "Feedback could not be reached. Try again.";
}

export function useFeedback({ root, position, lastTicks, spec, apply }: FeedbackInput): PositionFeedback {
  const [status, setStatus] = useState<{ readonly root: string; readonly status: FeedbackStatus | null } | null>(null);
  const [held, setHeld] = useState<{ readonly root: string; readonly state: Held } | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  // Whether feedback exists is asked once per product on show; any failure, a 403 included, leaves it hidden.
  useEffect(() => {
    const controller = new AbortController();
    getFeedbackStatus(controller.signal)
      .then((next) => setStatus({ root, status: next }))
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ root, status: null });
      });
    return () => controller.abort();
  }, [root]);

  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
      // An aborted request never settles, so its loading state would outlive it when the product comes back.
      setHeld((current) => (current?.state.kind === "loading" ? null : current));
    },
    [root],
  );

  const current = held?.root === root ? held.state : null;
  const offered = status?.root === root && feedbackOffered(status.status);
  const busy = current?.kind === "loading";

  const request = () => {
    if (!position || busy) return;
    const requested = position;
    const controller = new AbortController();
    inFlight.current = controller;
    setHeld({ root, state: { kind: "loading" } });
    const settle = (state: Held) => {
      if (controller.signal.aborted) return;
      inFlight.current = null;
      setHeld({ root, state });
    };
    requestFeedback(root, requested, controller.signal)
      .then((reply) => settle({ kind: "reply", reply, requested }))
      .catch((error: unknown) => {
        if (error instanceof FeedbackRefusedError) {
          if (error.kind === "unavailable") {
            // It went away since the status: hide it again.
            setStatus({ root, status: error.status });
            settle({ kind: "failed", message: "Feedback is not available." });
          } else if (error.kind === "over-budget" && error.status) {
            setStatus({ root, status: error.status });
            settle({ kind: "over-budget", status: error.status });
          } else {
            settle({ kind: "rate-limited", reason: error.reason, retryAfterSeconds: error.retryAfterSeconds });
          }
          return;
        }
        if (error instanceof ApiError && error.failure === "forbidden") setStatus({ root, status: null });
        settle({ kind: "failed", message: failureText(error) });
      });
  };

  const stale = (state: Held & { kind: "reply" }): StaleReason | null =>
    staleReason({
      requested: state.requested,
      current: position,
      asOfLastTicks: state.reply.metrics.lastTicks,
      atrTicks: state.reply.metrics.atrTicks,
      lastTicks,
    });

  let panel: FeedbackPanelState | null = null;
  let provider: PositionFeedback["provider"] = null;
  let ghosts: readonly FeedbackGhost[] = [];
  if (offered && current) {
    switch (current.kind) {
      case "reply": {
        const reason = stale(current);
        provider = current.reply.provider;
        panel = current.reply.feedback
          ? { kind: "answered", reply: current.reply, stale: reason }
          : { kind: "metrics-only", reply: current.reply, reason: current.reply.reason ?? "api-error", stale: reason };
        if (current.reply.feedback && reason === null) ghosts = suggestionGhosts(current.reply.feedback, spec);
        break;
      }
      case "loading":
      case "over-budget":
      case "rate-limited":
      case "failed":
        panel = current;
        break;
    }
  }

  return {
    offered,
    busy,
    request,
    close: () => {
      inFlight.current?.abort();
      inFlight.current = null;
      setHeld(null);
    },
    panel,
    provider,
    ghosts,
    applyGhost: (ghost) => {
      if (position) apply(moveLine(position, ghost.line, ghost.priceTicks));
    },
  };
}
