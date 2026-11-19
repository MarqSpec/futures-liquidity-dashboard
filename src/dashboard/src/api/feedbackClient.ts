import { ApiError, once, read, type CallOptions } from "./client.ts";
import {
  feedbackRefusalSchema,
  feedbackStatusSchema,
  planFeedbackReplySchema,
  type FeedbackRefusal,
  type FeedbackStatus,
  type PlanFeedbackReply,
} from "../domain/feedback.ts";
import type { Position } from "../domain/position.ts";

// The two feedback routes (REQUIREMENTS.md FR-74; INTERFACES.md D.1). The POST is never retried: each call may
// cost money, and the server allows one in flight per viewer.

/** The model can take up to its own 60 s deadline; wait a little longer than that. */
const FEEDBACK_TIMEOUT_MS = 70_000;

/** A 429 or 503 the server answered with a body: the budget is spent, a limit was hit, or feedback is off. */
export class FeedbackRefusedError extends Error {
  readonly kind: "over-budget" | "rate-limited" | "unavailable";
  readonly status: FeedbackStatus | null;
  readonly reason: string;
  readonly retryAfterSeconds: number | null;

  constructor(kind: FeedbackRefusedError["kind"], reason: string, status: FeedbackStatus | null, retryAfterSeconds: number | null) {
    super(`Feedback was refused: ${reason}.`);
    this.name = "FeedbackRefusedError";
    this.kind = kind;
    this.reason = reason;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryAfter(response: Response, refusal: FeedbackRefusal | null): number | null {
  const header = Number(response.headers.get("Retry-After"));
  return refusal?.retryAfterSeconds ?? (Number.isFinite(header) && header > 0 ? header : null);
}

async function readRefusal(response: Response): Promise<Error | null> {
  if (response.status !== 429 && response.status !== 503) return null;
  const body: unknown = await response.json().catch(() => undefined);
  const status = feedbackStatusSchema.safeParse(body);
  if (status.success) {
    const kind = response.status === 503 ? "unavailable" : "over-budget";
    return new FeedbackRefusedError(kind, status.data.reason ?? kind, status.data, retryAfter(response, null));
  }
  const refusal = feedbackRefusalSchema.safeParse(body);
  if (refusal.success && response.status === 429) {
    return new FeedbackRefusedError("rate-limited", refusal.data.reason, null, retryAfter(response, refusal.data));
  }
  return response.status === 503 ? new FeedbackRefusedError("unavailable", "unavailable", null, null) : new ApiError("server", "The API answered 429.");
}

/** GET /api/plans/feedback/status. A 403 fails as `forbidden`: the viewer lacks `request-feedback`. */
export function getFeedbackStatus(signal?: AbortSignal, options?: CallOptions): Promise<FeedbackStatus> {
  return read("/api/plans/feedback/status", feedbackStatusSchema, signal, options);
}

/** POST /api/plans/feedback/{root}: the metrics of `position`, and feedback on it when it could be written. */
export function requestFeedback(root: string, position: Position, signal?: AbortSignal): Promise<PlanFeedbackReply> {
  return once(
    `/api/plans/feedback/${encodeURIComponent(root)}`,
    planFeedbackReplySchema,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(position) },
    signal,
    { timeoutMs: FEEDBACK_TIMEOUT_MS },
    undefined,
    readRefusal,
  );
}
