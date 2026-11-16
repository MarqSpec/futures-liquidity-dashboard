import { describe, expect, it } from "vitest";

import { instrumentsFixture } from "../test/fixtures.ts";
import { retainUnchangedSummaries } from "./instrumentRows.ts";

describe("retainUnchangedSummaries", () => {
  it("should keep the same objects when a later poll is identical", () => {
    const previous = instrumentsFixture();

    const kept = retainUnchangedSummaries(previous, instrumentsFixture());

    expect(kept.every((row, index) => row === previous[index])).toBe(true);
  });

  it("should reuse the unchanged products when one product's last price changes", () => {
    const previous = instrumentsFixture();
    const next = instrumentsFixture().map((row, index) =>
      index === 0 ? { ...row, summary: { ...row.summary, last: (row.summary.last ?? 0) + 1 } } : row,
    );

    const kept = retainUnchangedSummaries(previous, next);

    expect(kept[0]).not.toBe(previous[0]);
    expect(kept[1]).toBe(previous[1]);
    expect(kept[2]).toBe(previous[2]);
  });
});
