import { describe, expect, it } from "vitest";

import { resolveTab, viewTabLabel, withTabParam } from "./tabs.ts";

describe("resolveTab", () => {
  it("should show Detail when neither the URL nor storage names a tab", () => {
    expect(resolveTab(null, null)).toBe("detail");
  });

  it("should prefer the URL's tab over the stored one", () => {
    expect(resolveTab("detail", "overview")).toBe("detail");
  });

  it("should use the stored tab when the URL names none", () => {
    expect(resolveTab(null, "overview")).toBe("overview");
  });

  it("should ignore a tab name it does not know", () => {
    expect(resolveTab("charts", 42)).toBe("detail");
  });

  it("should keep Order Flow when the URL asks for it, including the old bookmap name", () => {
    expect(resolveTab("orderflow", "overview")).toBe("bookmap");
    expect(resolveTab("bookmap", "overview")).toBe("bookmap");
    expect(resolveTab(null, "bookmap")).toBe("bookmap");
    expect(resolveTab(null, null)).toBe("detail");
  });
});

describe("viewTabLabel", () => {
  it("should name the instrument on Detail and Order Flow and leave Overview unnamed", () => {
    expect(viewTabLabel("detail", "MES")).toBe("Detail: MES");
    expect(viewTabLabel("bookmap", "MES")).toBe("Order Flow: MES");
    expect(viewTabLabel("overview", "MES")).toBe("Overview");
  });
});

describe("withTabParam", () => {
  it("should set the tab and keep other parameters when Overview is chosen", () => {
    expect(withTabParam(new URLSearchParams("perf=1"), "overview").toString()).toBe("perf=1&tab=overview");
  });

  it("should take the parameter out when Detail is chosen", () => {
    expect(withTabParam(new URLSearchParams("tab=overview&perf=1"), "detail").toString()).toBe("perf=1");
  });

  it("should set the orderflow parameter and keep the others", () => {
    expect(withTabParam(new URLSearchParams("perf=1"), "bookmap").toString()).toBe("perf=1&tab=orderflow");
    expect(withTabParam(new URLSearchParams("tab=bookmap"), "bookmap").toString()).toBe("tab=orderflow");
  });
});
