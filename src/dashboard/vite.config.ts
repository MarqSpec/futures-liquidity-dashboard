import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

import { appShellWorkbox, serviceWorkerUpdate } from "./src/lib/pwaPolicy.ts";

// The API in development (`dotnet run --launch-profile http` in MarqSpec.FuturesLiquidityDashboard.Api).
const api = "http://localhost:5080";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: serviceWorkerUpdate.registerType,
      injectRegister: false,
      manifest: {
        name: "Futures Liquidity Dashboard",
        short_name: "Liquidity",
        description: "Read-only live view of resting liquidity beside executed price.",
        theme_color: "#0b0e14",
        background_color: "#0b0e14",
        display: "standalone",
        start_url: "/",
        scope: "/",
        lang: "en",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: [...appShellWorkbox.globPatterns],
        navigateFallback: appShellWorkbox.navigateFallback,
        navigateFallbackDenylist: [...appShellWorkbox.navigateFallbackDenylist],
        runtimeCaching: [...appShellWorkbox.runtimeCaching],
        maximumFileSizeToCacheInBytes: appShellWorkbox.maximumFileSizeToCacheInBytes,
        skipWaiting: serviceWorkerUpdate.skipWaiting,
        clientsClaim: serviceWorkerUpdate.clientsClaim,
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/health": { target: api, changeOrigin: true },
      "/hubs": { target: api, changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // The layout and token tests read index.css and tokens.css through Vite's raw import. Other stylesheets stay mocked.
    css: { include: [/index\.css/, /tokens\.css/] },
  },
});
