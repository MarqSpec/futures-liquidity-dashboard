// reference: DEPLOYMENT.md
// The service worker may precache the static shell only. API, hub and health responses stay on the network.

/** Navigations that must not be answered with index.html. Workbox tests pathname plus search. */
export const SHELL_NAVIGATION_DENYLIST: readonly RegExp[] = [/^\/(api|hubs|health|metrics)(\/|\?|$)/];

/** Workbox options for the installed site. `runtimeCaching` stays empty so nothing but the precache is stored. */
export const appShellWorkbox = {
  globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"] as const,
  navigateFallback: "index.html",
  navigateFallbackDenylist: SHELL_NAVIGATION_DENYLIST,
  runtimeCaching: [] as const,
  maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
};

/** True when a navigation (pathname plus search, as Workbox sees it) may fall back to the app shell. */
export function isShellNavigation(pathAndSearch: string): boolean {
  return !SHELL_NAVIGATION_DENYLIST.some((pattern) => pattern.test(pathAndSearch));
}

/**
 * The string Workbox's NavigationRoute tests. It is pathname plus search, so a query is part of the
 * match. `$` alone does not exclude `/api?x=1`; the pattern has to allow `?`.
 */
export function workboxNavigationTarget(absoluteUrl: string): string {
  const url = new URL(absoluteUrl);
  return url.pathname + url.search;
}

/** The native shell bundles its own files and must not register a worker over them. */
export function shouldRegisterServiceWorker(native: boolean, hasServiceWorker: boolean): boolean {
  return !native && hasServiceWorker;
}

/**
 * An installed site asks before replacing an open dashboard. The worker waits until that tab reloads.
 * `autoUpdate` with `skipWaiting` reloaded every open tab on deploy.
 */
export const serviceWorkerUpdate = {
  registerType: "prompt" as const,
  skipWaiting: false,
  clientsClaim: false,
};
