// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { advisoryText, suggestionGhosts } from "../domain/feedback.ts";
import type { FeedbackPanelState } from "../hooks/useFeedback.ts";
import { feedbackFixture, feedbackSpec, replyFixture, statusFixture } from "../test/feedbackFixtures.ts";
import { FeedbackPanel } from "./FeedbackPanel.tsx";

// reference: REQUIREMENTS.md FR-74, NFR-8;

afterEach(cleanup);

const ghosts = suggestionGhosts(feedbackFixture(), feedbackSpec);

function show(state: FeedbackPanelState, over: { ghosts?: typeof ghosts; onApply?: () => void } = {}) {
  const onApply = over.onApply ?? vi.fn();
  const onClose = vi.fn();
  render(<FeedbackPanel state={state} spec={feedbackSpec} ghosts={over.ghosts ?? ghosts} onApply={onApply} onClose={onClose} />);
  return { onApply, onClose };
}

const answered = (over: Partial<ReturnType<typeof replyFixture>> = {}, stale: "position-changed" | "price-moved" | null = null): FeedbackPanelState => ({
  kind: "answered",
  reply: replyFixture(over),
  stale,
});

describe("FeedbackPanel with feedback", () => {
  it("should show the header, the as-of time in CT and the summary", () => {
    show(answered());
    const panel = screen.getByRole("complementary", { name: "Position feedback" });
    expect(within(panel).getByRole("heading", { name: "Feedback" })).toBeTruthy();
    expect(panel.textContent).toContain("as of 16:15:00 CT");
    expect(within(panel).getByText("A long limit near the bid with a two-to-one target.")).toBeTruthy();
  });

  it("should show a section per leg with the fill likelihood as text", () => {
    show(answered());
    const entry = screen.getByRole("region", { name: "Feedback on the entry" });
    expect(within(entry).getByText("Fill likelihood: high")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Feedback on the stop" })).getByText("Fill likelihood: low")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Feedback on the target 1" })).getByText("Fill likelihood: unknown")).toBeTruthy();
  });

  it("should show each suggestion as an arrow, its price and why", () => {
    show(answered());
    expect(within(screen.getByRole("region", { name: "Feedback on the entry" })).getByText(/→ 5000\.50, a wall sits at 20002/)).toBeTruthy();
  });

  it("should list each cited metric with its value from the same response", () => {
    show(answered());
    const entry = screen.getByRole("region", { name: "Feedback on the entry" });
    expect(entry.textContent).toContain("cites: distanceAtr -0.50 ATR; restingAhead.now 340 bid; throughFrequency.60 50% (29 of 58 bars)");
  });

  it("should show the risks with their cites", () => {
    show(answered());
    const risks = screen.getByRole("region", { name: "Risks" });
    expect(risks.textContent).toContain("A thin book behind the entry.");
    expect(risks.textContent).toContain("restingAhead.coverage10m entry 92%");
  });

  it("should always carry the advisory label", () => {
    show(answered());
    expect(screen.getByRole("note").textContent).toBe(advisoryText);
  });

  it("should keep the advisory label and MOCK together in a footer outside the scrolling answer", () => {
    show(answered({ provider: "mock", model: "mock" }));
    const note = screen.getByRole("note");
    const footer = note.closest("footer");
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByText("MOCK")).toBeTruthy();
    expect(note.closest(".feedback-panel")).toBeNull();
    expect(screen.getByText("MOCK").closest(".feedback-panel")).toBeNull();
  });

  it("should label mock feedback MOCK, and Claude's feedback not at all", () => {
    show(answered({ provider: "mock", model: "mock" }));
    expect(screen.getByText("MOCK")).toBeTruthy();
    cleanup();
    show(answered());
    expect(screen.queryByText("MOCK")).toBeNull();
  });

  it("should apply a suggestion when its Apply button is pressed from the keyboard", async () => {
    const user = userEvent.setup();
    const { onApply } = show(answered());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Feedback answer" }));
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Close");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Apply the suggested entry 5000.50" }));
    await user.keyboard("{Enter}");
    expect(onApply).toHaveBeenCalledWith(ghosts[0]);
  });

  it("should render a repeated risk or a repeated cite without a key collision", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const risk = { text: "Same risk.", cites: ["distanceTicks", "distanceTicks"] };
    show(answered({ feedback: feedbackFixture({ risks: [risk, risk] }) }));
    expect(screen.getAllByText("Same risk.")).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("should make the scrolling answer a named region that takes keyboard focus", () => {
    show(answered());
    const region = screen.getByRole("region", { name: "Feedback answer" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(within(region).getByRole("heading", { name: "Feedback" })).toBeTruthy();
  });

  it("should show how many claims the server removed, and nothing when none", () => {
    show(answered({ feedback: feedbackFixture({ droppedCites: 3 }) }));
    expect(screen.getByText(/^3 claims removed/)).toBeTruthy();
    cleanup();
    show(answered());
    expect(screen.queryByText(/claims? removed/)).toBeNull();
  });

  it("should mark stale feedback and not let a suggestion be applied", () => {
    show(answered({}, "position-changed"), { ghosts: [] });
    expect(screen.getByText("Stale: the position changed since this feedback.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Apply the suggested entry 5000.50" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should say why a stale price moved", () => {
    show(answered({}, "price-moved"), { ghosts: [] });
    expect(screen.getByText("Stale: the last price has moved more than 1 ATR since this feedback.")).toBeTruthy();
  });
});

describe("FeedbackPanel states", () => {
  it("should show the loading state with the advisory label", () => {
    show({ kind: "loading" });
    expect(screen.getByRole("status").textContent).toBe("Asking for feedback…");
    expect(screen.getByRole("note").textContent).toBe(advisoryText);
  });

  it("should show metrics only with the reason", () => {
    show({ kind: "metrics-only", reply: replyFixture({ feedback: null, reason: "timeout" }), reason: "timeout", stale: null });
    expect(screen.getByText("Metrics only: the model did not answer in time.")).toBeTruthy();
    expect(screen.getByText("entry 5000.00: -4 ticks from last")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe(advisoryText);
  });

  it("should show the over-budget state with the month's spend and cap", () => {
    show({ kind: "over-budget", status: statusFixture({ available: false, reason: "budget-exhausted", spentUsd: 100.4, budgetUsd: 100 }) });
    expect(screen.getByRole("status").textContent).toBe("Over budget: $100.40 spent of the $100.00 cap for 2026-11. Feedback resumes 2026-12-01 (UTC).");
  });

  it("should show the rate-limited state with the wait", () => {
    show({ kind: "rate-limited", reason: "rate-limited", retryAfterSeconds: 12 });
    expect(screen.getByRole("status").textContent).toBe("Rate limited: too many requests this minute. Try again in 12 s.");
  });

  it("should show a request already in flight", () => {
    show({ kind: "rate-limited", reason: "request-in-flight", retryAfterSeconds: null });
    expect(screen.getByRole("status").textContent).toContain("already running");
  });

  it("should show a failure as an alert", () => {
    show({ kind: "failed", message: "Feedback could not be reached. Try again." });
    expect(screen.getByRole("alert").textContent).toBe("Feedback could not be reached. Try again.");
  });

  it("should close when Close is pressed", async () => {
    const { onClose } = show({ kind: "loading" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
