import { describe, expect, it, vi } from "vitest";

import { resetServiceWorkerOffer, serviceWorkerOffer } from "./lib/pwaUpdate.ts";
import { registerAppShell } from "./pwaRegister.ts";

interface RegisterHooks {
  onNeedRefresh?: () => void;
  onNeedReload?: () => void;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("registerAppShell", () => {
  it("should not register inside the native shell", () => {
    const load = vi.fn();
    registerAppShell(true, load, () => undefined);
    expect(load).not.toHaveBeenCalled();
  });

  it("should not reload an open tab until that tab accepts the update", async () => {
    resetServiceWorkerOffer();
    let hooks: RegisterHooks = {};
    const update = vi.fn(async () => undefined);
    const reload = vi.fn();
    registerAppShell(
      false,
      async () => ({
        registerSW(options) {
          hooks = options ?? {};
          return update;
        },
      }),
      reload,
      true,
    );
    await flush();

    hooks.onNeedReload?.();
    expect(reload).not.toHaveBeenCalled();

    hooks.onNeedRefresh?.();
    expect(update).not.toHaveBeenCalled();
    serviceWorkerOffer().apply();
    await flush();
    await flush();

    expect(update).toHaveBeenCalledWith(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});
