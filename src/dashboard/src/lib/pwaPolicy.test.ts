import { describe, expect, it } from "vitest";

import { appShellWorkbox, isShellNavigation, serviceWorkerUpdate, shouldRegisterServiceWorker, workboxNavigationTarget } from "./pwaPolicy.ts";

describe("appShellWorkbox", () => {
  it("should cache no runtime responses", () => {
    expect(appShellWorkbox.runtimeCaching).toEqual([]);
  });

  it("should precache only static app-shell files", () => {
    expect(appShellWorkbox.globPatterns.join(" ")).not.toMatch(/json|api|hub/);
    expect(appShellWorkbox.navigateFallback).toBe("index.html");
  });

  it("should precache the bundled woff2 fonts when the app is installed", () => {
    // IBM Plex ships in the bundle so the installed app and the Android shell render it offline.
    expect(appShellWorkbox.globPatterns.some((pattern) => /[{,.]woff2[,}]/.test(pattern))).toBe(true);
  });
});

describe("isShellNavigation", () => {
  it("should treat the app routes as shell navigations", () => {
    expect(isShellNavigation("/")).toBe(true);
    expect(isShellNavigation("/index.html")).toBe(true);
  });

  it("should refuse API, hub, health and metrics navigations, including a query", () => {
    for (const path of [
      "/api",
      "/api/",
      "/api/instruments",
      "/api?x=1",
      "/hubs",
      "/hubs/market",
      "/hubs/market/negotiate",
      "/hubs?x",
      "/health",
      "/health/live",
      "/health/ready",
      "/health?x",
      "/metrics",
      "/metrics?x=1",
    ]) {
      expect(isShellNavigation(path)).toBe(false);
    }
  });

  it("should not treat a different path that shares a prefix as an API path", () => {
    expect(isShellNavigation("/apiary")).toBe(true);
    expect(isShellNavigation("/healthcare")).toBe(true);
  });

  it("should deny the pathname-plus-search string Workbox tests, including a query", () => {
    for (const absolute of [
      "https://dashboard.example/api",
      "https://dashboard.example/api?x=1",
      "https://dashboard.example/api/instruments?root=MES",
      "https://dashboard.example/hubs",
      "https://dashboard.example/hubs?x",
      "https://dashboard.example/hubs/market?access_token=synthetic",
      "https://dashboard.example/health",
      "https://dashboard.example/health?x",
      "https://dashboard.example/health/ready",
      "https://dashboard.example/metrics",
      "https://dashboard.example/metrics?x=1",
    ]) {
      expect(isShellNavigation(workboxNavigationTarget(absolute))).toBe(false);
    }
    expect(isShellNavigation(workboxNavigationTarget("https://dashboard.example/?tab=overview"))).toBe(true);
    expect(isShellNavigation(workboxNavigationTarget("https://dashboard.example/apiary?x=1"))).toBe(true);
  });
});

describe("serviceWorkerUpdate", () => {
  it("should wait for the viewer instead of reloading an open dashboard", () => {
    expect(serviceWorkerUpdate).toEqual({ registerType: "prompt", skipWaiting: false, clientsClaim: false });
  });
});

describe("shouldRegisterServiceWorker", () => {
  it("should register only in a browser that can host a worker", () => {
    expect(shouldRegisterServiceWorker(false, true)).toBe(true);
  });

  it("should not register inside the native shell", () => {
    expect(shouldRegisterServiceWorker(true, true)).toBe(false);
  });

  it("should not register when the browser has no service worker", () => {
    expect(shouldRegisterServiceWorker(false, false)).toBe(false);
  });
});
