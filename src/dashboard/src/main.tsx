import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";

// IBM Plex, bundled (latin subset) so it renders offline; the token font stacks fall back to system fonts.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-700.css";

import { AuthGate } from "./components/AuthGate.tsx";
import { ServiceWorkerUpdate } from "./components/ServiceWorkerUpdate.tsx";
import "./design/tokens.css";
import "./index.css";
import { colorTheme } from "./lib/colorTheme.ts";
import { registerAppShell } from "./pwaRegister.ts";
import { AppGate } from "./routes/AppGate.tsx";
import { router } from "./router.tsx";

// The theme is on <html> and the canvases before the first render, so nothing paints in the wrong one.
colorTheme.start();
registerAppShell();

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html has no #root element");
}

createRoot(container).render(
  <StrictMode>
    <AppGate>
      <ServiceWorkerUpdate />
      <AuthGate>
        <RouterProvider router={router} />
      </AuthGate>
    </AppGate>
  </StrictMode>,
);
