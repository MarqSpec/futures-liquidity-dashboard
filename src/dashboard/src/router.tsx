import { createBrowserRouter } from "react-router";

import { dashboardLoader, dashboardShouldRevalidate } from "./routes/dashboardLoader.ts";
import { RootErrorBoundary } from "./routes/RootErrorBoundary.tsx";
import { RootLayout } from "./routes/RootLayout.tsx";

// The app's routes (CONVENTIONS.md §3), created once. Every route renders inside RootLayout and under the
// root error boundary (§7); a route that needs data gets a `loader`. nginx serves index.html for any path, so a
// deep link reaches the router. The dashboard is read-only: there is no route that trades.
export const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    ErrorBoundary: RootErrorBoundary,
    children: [
      {
        index: true,
        loader: dashboardLoader,
        shouldRevalidate: dashboardShouldRevalidate,
        lazy: async () => ({ Component: (await import("./routes/DashboardRoute.tsx")).DashboardRoute }),
      },
    ],
  },
]);
