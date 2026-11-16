import { z } from "zod";

// Build-time configuration (CONVENTIONS.md §6). Everything here is public: Vite inlines VITE_* into the
// bundle. Leave VITE_API_BASE_URL unset (the default) so every request is a same-origin relative URL: in development
// the Vite proxy (vite.config.ts) forwards /api, /health and /hubs to http://localhost:5080, and in the container
// nginx (nginx.conf.template) forwards /api, /health, /hubs (WebSocket upgrade) and /metrics to the compose
// service futuresliquiditydashboard.api:8080. The API sends no CORS headers, so a cross-origin base URL only works
// behind a proxy that makes it same-origin. The Android shell is not that proxy: it reads a server URL the
// viewer saved (src/lib/serverUrl.ts, DEPLOYMENT.md). This value stays the browser default, and the
// shell ignores it, so an empty VITE_API_BASE_URL still means same-origin relative URLs on the web.
const env = z
  .object({ VITE_API_BASE_URL: z.url().or(z.literal("")).optional() })
  .parse(import.meta.env);

const base = (env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/** The parsed configuration the app reads. The hub URL is derived at call time (src/lib/serverUrl.ts). */
export const config = {
  apiBaseUrl: base,
} as const;
