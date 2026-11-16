import { isNativeShell } from "./lib/serverUrl.ts";
import { shouldRegisterServiceWorker } from "./lib/pwaPolicy.ts";
import { offerServiceWorkerUpdate, shouldReloadForServiceWorkerUpdate } from "./lib/pwaUpdate.ts";

interface RegisterHooks {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onNeedReload?: () => void;
}

type RegisterSw = (options?: RegisterHooks) => (reloadPage?: boolean) => Promise<void>;

/** Registers the app-shell worker in the browser. The Android shell returns without registering. */
export function registerAppShell(
  native: boolean = isNativeShell(),
  load: () => Promise<{ registerSW: RegisterSw }> = () => import("virtual:pwa-register"),
  reload: () => void = () => {
    globalThis.location.reload();
  },
  hasServiceWorker: boolean = typeof navigator !== "undefined" && "serviceWorker" in navigator,
): void {
  if (!shouldRegisterServiceWorker(native, hasServiceWorker)) {
    return;
  }
  const box: { update: (reloadPage?: boolean) => Promise<void> } = {
    update: async () => undefined,
  };
  void load()
    .then(({ registerSW }) => {
      box.update = registerSW({
        immediate: true,
        onNeedRefresh() {
          offerServiceWorkerUpdate(() => {
            void box.update(true).finally(() => {
              if (shouldReloadForServiceWorkerUpdate()) {
                reload();
              }
            });
          });
        },
        onNeedReload() {
          // The module reloads every controlled tab. Accepting is per tab, so the others stay up.
          if (shouldReloadForServiceWorkerUpdate()) {
            reload();
          }
        },
      });
    })
    .catch(() => {
      // The page still works when registration fails. nginx serves the same files.
    });
}
