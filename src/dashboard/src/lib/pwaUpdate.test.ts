import { describe, expect, it, vi } from "vitest";

import {
  offerServiceWorkerUpdate,
  resetServiceWorkerOffer,
  serviceWorkerOffer,
  shouldReloadForServiceWorkerUpdate,
} from "./pwaUpdate.ts";

describe("service worker update offer", () => {
  it("should keep the dashboard running when an update is waiting and the viewer has not accepted it", () => {
    resetServiceWorkerOffer();
    const apply = vi.fn();
    offerServiceWorkerUpdate(apply);

    expect(serviceWorkerOffer().available).toBe(true);
    expect(shouldReloadForServiceWorkerUpdate()).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("should reload only after the viewer accepts, and should hide the offer when they dismiss it", () => {
    resetServiceWorkerOffer();
    const apply = vi.fn();
    offerServiceWorkerUpdate(apply);

    serviceWorkerOffer().dismiss();

    expect(serviceWorkerOffer().available).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(shouldReloadForServiceWorkerUpdate()).toBe(false);

    offerServiceWorkerUpdate(apply);
    serviceWorkerOffer().apply();

    expect(apply).toHaveBeenCalledOnce();
    expect(shouldReloadForServiceWorkerUpdate()).toBe(true);
    expect(serviceWorkerOffer().available).toBe(false);
  });
});
