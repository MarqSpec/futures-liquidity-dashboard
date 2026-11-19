import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./client.ts";
import { FeedbackRefusedError, getFeedbackStatus, requestFeedback } from "./feedbackClient.ts";
import { feedbackPosition, replyFixture, statusFixture } from "../test/feedbackFixtures.ts";

// reference: REQUIREMENTS.md FR-74; INTERFACES.md D.1

function stub(response: Response) {
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getFeedbackStatus", () => {
  it("should parse the status", async () => {
    const fetchMock = stub(Response.json(statusFixture()));
    expect((await getFeedbackStatus()).available).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/plans/feedback/status");
  });

  it("should fail as forbidden when the viewer lacks request-feedback", async () => {
    stub(new Response("", { status: 403 }));
    await expect(getFeedbackStatus()).rejects.toMatchObject({ failure: "forbidden" });
  });

  it("should fail as a bad response when the body is not a status", async () => {
    stub(Response.json({ available: "yes" }));
    await expect(getFeedbackStatus()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("requestFeedback", () => {
  it("should POST the position to the root's route, once", async () => {
    const fetchMock = stub(Response.json(replyFixture()));
    const reply = await requestFeedback("MES", feedbackPosition);
    expect(reply.provider).toBe("claude");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/plans/feedback/MES");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(JSON.parse(JSON.stringify(feedbackPosition)));
  });

  it("should not retry a 5xx", async () => {
    const fetchMock = stub(new Response("", { status: 502 }));
    await expect(requestFeedback("MES", feedbackPosition)).rejects.toMatchObject({ failure: "server" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("should throw the budget status on a 429 that carries one", async () => {
    stub(Response.json(statusFixture({ available: false, reason: "budget-exhausted", spentUsd: 100 }), { status: 429, headers: { "Retry-After": "3600" } }));
    const error = await requestFeedback("MES", feedbackPosition).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FeedbackRefusedError);
    expect(error).toMatchObject({ kind: "over-budget", status: { spentUsd: 100 } });
  });

  it.each(["rate-limited", "request-in-flight"])("should throw %s with its retry delay on a 429", async (reason) => {
    stub(Response.json({ reason, retryAfterSeconds: 12 }, { status: 429 }));
    const error = await requestFeedback("MES", feedbackPosition).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "rate-limited", reason, retryAfterSeconds: 12 });
  });

  it("should throw unavailable on a 503 with the status", async () => {
    stub(Response.json(statusFixture({ available: false, reason: "no-key" }), { status: 503 }));
    const error = await requestFeedback("MES", feedbackPosition).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "unavailable" });
  });

  it("should fail as forbidden on a 403", async () => {
    stub(new Response("", { status: 403 }));
    await expect(requestFeedback("MES", feedbackPosition)).rejects.toMatchObject({ failure: "forbidden" });
  });
});
