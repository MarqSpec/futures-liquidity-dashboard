// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { Hint } from "./Hint.tsx";


afterEach(cleanup);

function renderHinted() {
  render(
    <div>
      <Hint label="Flow" text="Colours each cell by size added or pulled.">
        {(hint) => (
          <button type="button" {...hint}>
            Flow
          </button>
        )}
      </Hint>
      <button type="button">Elsewhere</button>
    </div>,
  );
  return screen.getByRole("button", { name: "Flow" });
}

describe("Hint", () => {
  it("should show the hint when the control takes keyboard focus", async () => {
    const user = userEvent.setup();
    renderHinted();

    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.tab();

    expect(screen.getByRole("tooltip").textContent).toBe("Colours each cell by size added or pulled.");
  });

  it("should show the hint on hover and hide it when the pointer leaves", async () => {
    const user = userEvent.setup();
    const control = renderHinted();

    await user.hover(control);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    await user.unhover(control);

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("should hide the hint when focus moves away", async () => {
    const user = userEvent.setup();
    renderHinted();

    await user.tab();
    await user.tab();

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("should hide the hint on Escape while the pointer is still over the control", async () => {
    const user = userEvent.setup();
    const control = renderHinted();

    await user.hover(control);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("should hide the hint when the page scrolls or resizes so it is never left detached", async () => {
    const user = userEvent.setup();
    const control = renderHinted();

    await user.hover(control);
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.unhover(control);
    await user.hover(control);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent(window, new Event("resize"));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("should keep the hint open when a key other than Escape is pressed", async () => {
    const user = userEvent.setup();
    const control = renderHinted();

    await user.hover(control);
    await user.keyboard("a");

    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("should describe the control by the hint, shown or not, through aria-describedby", async () => {
    const user = userEvent.setup();
    const control = renderHinted();
    const id = control.getAttribute("aria-describedby");

    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")?.textContent).toBe("Colours each cell by size added or pulled.");
    expect(document.getElementById(id ?? "")?.hidden).toBe(true);
    await user.tab();
    expect(document.getElementById(id ?? "")?.hidden).toBe(false);
  });

  it("should leave the control without a native title", () => {
    const control = renderHinted();

    expect(control.hasAttribute("title")).toBe(false);
  });

  it("should toggle the hint from the info button a touch user taps", async () => {
    const user = userEvent.setup();
    renderHinted();
    const toggle = screen.getByRole("button", { name: "Explain Flow" });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);

    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("should hide a toggled hint when focus leaves the info button", async () => {
    const user = userEvent.setup();
    renderHinted();

    await user.click(screen.getByRole("button", { name: "Explain Flow" }));
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("should hide a toggled hint on Escape", async () => {
    const user = userEvent.setup();
    renderHinted();

    await user.click(screen.getByRole("button", { name: "Explain Flow" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
