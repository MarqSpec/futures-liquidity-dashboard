// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { defaultLayout, withPane, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { MarketView } from "./MarketView.tsx";

// Each Detail side-column section folds to its heading, and the folded set is saved with the layout.

const market = fromSnapshot(snapshotFixture(), 5, 0);
const noop = () => undefined;

/** Each section: its region's name and its heading button's name. */
const sections = [
  ["ladder", "Depth ladder", /^Depth/],
  ["conditions", "Conditions", /^Conditions$/],
  ["liquidity", "Liquidity metrics", /^Liquidity/],
  ["signals", "Order-flow signals", /^Signals$/],
  ["levels", "Levels", /^Levels/],
  ["profile", "Volume profile", /^Profile$/],
  ["layers", "Layers", /^Layers$/],
] as const;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
});

function Harness({ initial }: { readonly initial: LayoutSettings }) {
  const [layout, setLayout] = useState<LayoutSettings>(initial);
  return (
    <>
      <output data-testid="saved">{layout.sideSectionsCollapsed.join(",")}</output>
      <MarketView
        market={market}
        layout={layout}
        viewWindow={defaultWindow(5)}
        crosshair={createCrosshairStore()}
        onWindow={noop}
        onResetWindow={noop}
        onTogglePane={noop}
        onToggleKind={noop}
        onReading={(change) => setLayout((current) => change(current))}
      />
    </>
  );
}

/** Every section shown, the profile included, so all seven can be driven. */
const withProfile = withPane(defaultLayout, "profile-session", true);

function headingButton(region: string, name: RegExp): HTMLElement {
  return within(screen.getByRole("region", { name: region })).getByRole("button", { name });
}

function body(button: HTMLElement): HTMLElement {
  const id = button.getAttribute("aria-controls") ?? "";
  const element = document.getElementById(id);
  if (!element) throw new Error(`no element controlled by ${button.textContent ?? ""}`);
  return element;
}

describe("MarketView side sections", () => {
  it("should give every section an expanded heading button that controls its body when nothing is collapsed", () => {
    render(<Harness initial={withProfile} />);

    for (const [, region, name] of sections) {
      const button = headingButton(region, name);
      expect(button.closest("h2"), region).not.toBeNull();
      expect(button.getAttribute("aria-expanded"), region).toBe("true");
      expect(body(button).hidden, region).toBe(false);
      expect(screen.getByRole("region", { name: region }).contains(body(button)), region).toBe(true);
    }
  });

  it("should fold a section to its heading and save its key when the viewer collapses it", async () => {
    const user = userEvent.setup();
    render(<Harness initial={withProfile} />);

    await user.click(headingButton("Depth ladder", /^Depth/));
    await user.click(headingButton("Layers", /^Layers$/));

    const ladder = headingButton("Depth ladder", /^Depth/);
    expect(ladder.getAttribute("aria-expanded")).toBe("false");
    expect(body(ladder).hidden).toBe(true);
    expect(within(screen.getByRole("region", { name: "Depth ladder" })).queryByRole("table")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Depth ladder" })).getByRole("heading", { name: /^Depth/ })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Layers" })).queryByRole("checkbox", { name: /Liquidity heatmap/ })).toBeNull();
    expect(headingButton("Liquidity metrics", /^Liquidity/).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("saved").textContent).toBe("ladder,layers");
  });

  it("should start each saved section folded and leave the others open when the layout names them", () => {
    render(<Harness initial={{ ...withProfile, sideSectionsCollapsed: ["signals", "levels", "profile"] }} />);

    for (const [key, region, name] of sections) {
      const folded = key === "signals" || key === "levels" || key === "profile";
      const button = headingButton(region, name);
      expect(button.getAttribute("aria-expanded"), region).toBe(folded ? "false" : "true");
      expect(body(button).hidden, region).toBe(folded);
    }
    expect(within(screen.getByRole("region", { name: "Volume profile" })).queryByRole("group", { name: "Profile window" })).toBeNull();
  });

  it("should open and fold a section from the keyboard when the viewer presses Enter or Space on its heading", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...withProfile, sideSectionsCollapsed: ["liquidity"] }} />);

    headingButton("Liquidity metrics", /^Liquidity/).focus();
    await user.keyboard("{Enter}");

    expect(headingButton("Liquidity metrics", /^Liquidity/).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("saved").textContent).toBe("");

    await user.keyboard(" ");

    expect(headingButton("Liquidity metrics", /^Liquidity/).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("saved").textContent).toBe("liquidity");
  });

  it("should keep the profile's window picker beside its heading when the profile is open", () => {
    render(<Harness initial={withProfile} />);

    const region = screen.getByRole("region", { name: "Volume profile" });
    expect(within(region).getByRole("group", { name: "Profile window" })).toBeTruthy();
  });
});
