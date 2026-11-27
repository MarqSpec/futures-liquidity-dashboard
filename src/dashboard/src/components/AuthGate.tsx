import { useEffect, useState, type ReactNode } from "react";

import { getAuthConfig } from "../api/client.ts";
import type { OidcClientConfig } from "../lib/oidc.ts";
import { isNativeShell } from "../lib/serverUrl.ts";
import { ApiKeyGate } from "./ApiKeyGate.tsx";
import { SignInGate } from "./SignInGate.tsx";

// reference: ARCHITECTURE.md D-77

type Mode = { readonly kind: "checking" } | { readonly kind: "key" } | { readonly kind: "sign-in"; readonly config: OidcClientConfig };

/**
 * Asks the API how viewers sign in. With sign-in on, the browser signs in with the provider; otherwise, and always in
 * the native shell, it asks for an API key as before. An API that cannot be reached falls to the key gate, which
 * already shows that state and retries.
 */
export function AuthGate({ children }: { readonly children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(() => (isNativeShell() ? { kind: "key" } : { kind: "checking" }));

  useEffect(() => {
    if (mode.kind !== "checking") {
      return;
    }
    const controller = new AbortController();
    void getAuthConfig(controller.signal).then(
      (answer) => setMode(answer.oidc ? { kind: "sign-in", config: answer.oidc } : { kind: "key" }),
      () => {
        if (!controller.signal.aborted) {
          setMode({ kind: "key" });
        }
      },
    );
    return () => {
      controller.abort();
    };
  }, [mode.kind]);

  switch (mode.kind) {
    case "checking":
      return (
        <main className="key-gate">
          <output>Checking access…</output>
        </main>
      );
    case "key":
      return <ApiKeyGate>{children}</ApiKeyGate>;
    case "sign-in":
      return <SignInGate config={mode.config}>{children}</SignInGate>;
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}
