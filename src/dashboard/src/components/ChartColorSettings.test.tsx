// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { CHART_COLOR_GROUPS, CHART_COLOR_ROLES } from "../design/chartColors.ts";
import { color } from "../design/tokens.ts";
import { createChartColorStore, type ChartColorStore } from "../lib/chartColorOverrides.ts";
import { canvasTheme } from "../theme.ts";
import { ChartColorSettings } from "./ChartColorSettings.tsx";

// The chart colour settings: every role grouped by meaning, a picker, a sample, its worst contrast with a warning
// below its NFR-8 floor, a reset per role and a Reset all, keyboard-operable.

afterEach(() => {
  cleanup();
  act(() => canvasTheme.set("dark"));
});

function setup(): { readonly store: ChartColorStore; readonly user: ReturnType<typeof userEvent.setup> } {
  const store = createChartColorStore({ storage: () => undefined });
  const user = userEvent.setup();
  render(<ChartColorSettings store={store} />);
  return { store, user };
}

async function open(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Chart colours" }));
  return screen.getByRole("dialog", { name: /Chart colours/ });
}

describe("ChartColorSettings", () => {
  it("should open from its button, say it is expanded and name the theme it edits", async () => {
    const { user } = setup();
    const button = screen.getByRole("button", { name: "Chart colours" });
    expect(button.getAttribute("aria-expanded")).toBe("false");

    const panel = await open(user);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(within(panel).getByRole("heading", { name: "Chart colours: Terminal" })).toBeTruthy();
  });

  it("should list every role under its group when the panel is open", async () => {
    const { user } = setup();

    const panel = await open(user);

    expect(within(panel).getAllByRole("group").map((group) => group.querySelector("legend")?.textContent)).toEqual([...CHART_COLOR_GROUPS]);
    for (const role of CHART_COLOR_ROLES) {
      const input = within(panel).getByLabelText(role.name);
      expect((input as HTMLInputElement).type).toBe("color");
      expect((input as HTMLInputElement).value).toBe(color(role.token));
    }
  });

  it("should warn about no theme default when nothing is overridden", async () => {
    const { user } = setup();

    const panel = await open(user);

    expect(within(panel).queryAllByText(/Below its/)).toEqual([]);
  });

  it("should set the role in the active theme and show it when a colour is picked", async () => {
    const { store, user } = setup();
    const panel = await open(user);

    fireEvent.change(within(panel).getByLabelText("Buying / up"), { target: { value: "#123456" } });

    expect(store.overrides()).toEqual({ dark: { up: "#123456" }, light: {} });
    expect((within(panel).getByLabelText("Buying / up") as HTMLInputElement).value).toBe("#123456");
  });

  it("should show the worst contrast and warn, yet keep the colour, when a pick falls below its floor", async () => {
    const { store, user } = setup();
    const panel = await open(user);

    fireEvent.change(within(panel).getByLabelText("VWAP"), { target: { value: color("surface-highest") } });

    const input = within(panel).getByLabelText("VWAP");
    const description = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toMatch(/1\.0:1 at worst/);
    expect(description?.textContent).toMatch(/Below its 3:1 floor for lines/);
    expect(store.overrides().dark.vwap).toBe(color("surface-highest"));
  });

  it("should return one role to its theme default from its reset button, enabled only while it is overridden", async () => {
    const { store, user } = setup();
    const panel = await open(user);
    const reset = within(panel).getByRole("button", { name: "Reset Bid depth" });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText("Bid depth"), { target: { value: "#a0522d" } });
    fireEvent.change(within(panel).getByLabelText("Buying / up"), { target: { value: "#123456" } });
    expect((reset as HTMLButtonElement).disabled).toBe(false);

    await user.click(reset);

    expect(store.overrides().dark).toEqual({ up: "#123456" });
    expect((within(panel).getByLabelText("Bid depth") as HTMLInputElement).value).toBe(color("bid"));
  });

  it("should return every role of the theme to its default from Reset all", async () => {
    const { store, user } = setup();
    const panel = await open(user);
    fireEvent.change(within(panel).getByLabelText("Buying / up"), { target: { value: "#123456" } });
    fireEvent.change(within(panel).getByLabelText("Bid depth"), { target: { value: "#a0522d" } });

    await user.click(within(panel).getByRole("button", { name: "Reset all" }));

    expect(store.overrides().dark).toEqual({});
  });

  it("should edit Light's colours, and leave Terminal's, when the Light theme is on", async () => {
    act(() => canvasTheme.set("light"));
    const { store, user } = setup();
    const panel = await open(user);

    fireEvent.change(within(panel).getByLabelText("Buying / up"), { target: { value: "#123456" } });

    expect(within(panel).getByRole("heading", { name: "Chart colours: Light" })).toBeTruthy();
    expect(store.overrides()).toEqual({ dark: {}, light: { up: "#123456" } });
  });

  it("should close on Escape and give focus back to its button", async () => {
    const { user } = setup();
    await open(user);
    await user.click(screen.getByLabelText("VWAP"));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Chart colours" }));
  });

  it("should be reachable from the keyboard: Enter opens it and Tab reaches the first picker", async () => {
    const { user } = setup();
    screen.getByRole("button", { name: "Chart colours" }).focus();

    await user.keyboard("{Enter}");
    await user.tab();
    await user.tab();

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Buying / up"));
  });
});
