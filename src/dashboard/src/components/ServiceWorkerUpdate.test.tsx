// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { offerServiceWorkerUpdate, resetServiceWorkerOffer } from "../lib/pwaUpdate.ts";
import { ServiceWorkerUpdate } from "./ServiceWorkerUpdate.tsx";

describe("ServiceWorkerUpdate", () => {
  afterEach(() => {
    cleanup();
    resetServiceWorkerOffer();
  });

  it("should say nothing when no update is waiting", () => {
    resetServiceWorkerOffer();
    render(<ServiceWorkerUpdate />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should leave the tab running when the viewer dismisses the update", async () => {
    const apply = vi.fn();
    offerServiceWorkerUpdate(apply);
    render(<ServiceWorkerUpdate />);

    expect(screen.getByRole("status").textContent).toContain("keeps running");
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(apply).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should apply the update when the viewer reloads this tab", async () => {
    const apply = vi.fn();
    offerServiceWorkerUpdate(apply);
    render(<ServiceWorkerUpdate />);

    await userEvent.click(screen.getByRole("button", { name: "Reload to update" }));

    expect(apply).toHaveBeenCalledOnce();
  });
});
