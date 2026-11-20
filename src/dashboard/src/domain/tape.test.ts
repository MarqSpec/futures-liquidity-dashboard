import { describe, expect, it } from "vitest";

import type { Tape } from "../api/schemas.ts";
import { tapeHint, tapeStateText } from "./tape.ts";

// (REQUIREMENTS.md FR-83)

const thin: Tape = { state: "Thin", rate: 0.1, baselineRate: 4, thinBelowRate: 1, baselineMinutes: 30 };

describe("tapeStateText", () => {
  it("should name each state in plain words when the server sends one", () => {
    expect([thin, { ...thin, state: "Active" as const }, { ...thin, state: "Unknown" as const }].map(tapeStateText)).toEqual([
      "thin",
      "active",
      "no reading",
    ]);
  });

  it("should say nothing when an older server sends no tape", () => {
    expect(tapeStateText(null)).toBeNull();
  });
});

describe("tapeHint", () => {
  it("should state the rate, the median and the limit the server judged when the tape is thin", () => {
    expect(tapeHint(thin)).toBe("Tape thin: 0.1/s against a 30-minute median of 4.0/s; thin below 1.0/s");
  });

  // (the ruling A)
  it("should name every reason there can be no reading when the state is unknown", () => {
    expect(tapeHint({ ...thin, state: "Unknown", baselineRate: null, thinBelowRate: null })).toBe(
      "Tape: no reading (feed recovering or stale, exchange closed, warmup still in the last 10 s, under 30 minutes seen, or most of them without a print); 0.1/s",
    );
  });
});
