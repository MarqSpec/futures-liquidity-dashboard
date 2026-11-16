import { useSyncExternalStore } from "react";

import { serviceWorkerOffer, subscribeServiceWorkerOffer } from "../lib/pwaUpdate.ts";

/**
 * Offers a waiting app-shell update without reloading the tab. The chart stays up until this tab asks to reload.
 */
export function ServiceWorkerUpdate() {
  const offer = useSyncExternalStore(subscribeServiceWorkerOffer, serviceWorkerOffer, serviceWorkerOffer);
  if (!offer.available) {
    return null;
  }
  return (
    <output className="update-banner">
      <p>A new version is ready. This tab keeps running until you reload it.</p>
      <button type="button" onClick={offer.apply}>
        Reload to update
      </button>
      <button type="button" onClick={offer.dismiss}>
        Not now
      </button>
    </output>
  );
}
