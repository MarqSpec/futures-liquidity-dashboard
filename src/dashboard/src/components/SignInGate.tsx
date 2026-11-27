import { useEffect, useRef, useState, type ReactNode } from "react";

import { subscribeUnauthorized } from "../lib/apiKey.ts";
import {
  CALLBACK_PATH,
  OidcError,
  beginSignIn,
  completeSignIn,
  discover,
  needsRefresh,
  readSession,
  refreshSession,
  signOut,
  type OidcClientConfig,
  type OidcEndpoints,
} from "../lib/oidc.ts";

// reference: ARCHITECTURE.md D-77

type GateState =
  | { readonly phase: "checking" }
  | { readonly phase: "signed-out"; readonly message: string | null }
  | { readonly phase: "signed-in" }
  | { readonly phase: "failed"; readonly message: string };

/** What the gate needs from the page. Tests pass their own. */
export interface SignInGateEnvironment {
  readonly href: () => string;
  readonly origin: () => string;
  readonly replacePath: (path: string) => void;
  readonly assign: (url: string) => void;
  readonly fetcher: typeof fetch;
  readonly now: () => number;
}

const browser: SignInGateEnvironment = {
  href: () => globalThis.location.href,
  origin: () => globalThis.location.origin,
  replacePath: (path) => globalThis.history.replaceState(null, "", path),
  assign: (url) => globalThis.location.assign(url),
  fetcher: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
};

function messageOf(error: unknown): string {
  return error instanceof OidcError ? error.message : "Sign-in failed. Try again.";
}

/**
 * Opens the dashboard once this tab has signed in with the provider, in place of the API key prompt. It finishes a
 * sign-in that returns to the callback path, refreshes the token before it expires, and asks the viewer to sign in
 * again when the API answers 401 and the refresh token is gone. What a signed-in user may do is the API's decision.
 */
export function SignInGate({
  config,
  children,
  environment = browser,
}: {
  readonly config: OidcClientConfig;
  readonly children: ReactNode;
  readonly environment?: SignInGateEnvironment;
}) {
  const [state, setState] = useState<GateState>({ phase: "checking" });
  const endpoints = useRef<OidcEndpoints | null>(null);

  useEffect(() => {
    let active = true;
    const settle = (next: GateState) => {
      if (active) {
        setState(next);
      }
    };

    const start = async () => {
      const found = await discover(config.authority, environment.fetcher);
      endpoints.current = found;
      const href = environment.href();
      if (new URL(href).pathname === CALLBACK_PATH) {
        const returnTo = await completeSignIn(href, config, found, environment.fetcher, environment.now);
        environment.replacePath(returnTo);
        return settle({ phase: "signed-in" });
      }
      const session = readSession();
      if (!session) {
        return settle({ phase: "signed-out", message: null });
      }
      if (needsRefresh(session, environment.now())) {
        await refreshSession(config, found, environment.fetcher, environment.now);
      }
      return settle({ phase: "signed-in" });
    };

    void start().catch((error: unknown) => {
      if (new URL(environment.href()).pathname === CALLBACK_PATH) {
        environment.replacePath("/");
      }
      settle(endpoints.current ? { phase: "signed-out", message: messageOf(error) } : { phase: "failed", message: messageOf(error) });
    });

    const stop = subscribeUnauthorized(() => {
      const found = endpoints.current;
      if (!found) {
        return;
      }
      void refreshSession(config, found, environment.fetcher, environment.now).then(
        () => settle({ phase: "signed-in" }),
        () => settle({ phase: "signed-out", message: "The session has ended. Sign in again." }),
      );
    });

    return () => {
      active = false;
      stop();
    };
  }, [config, environment]);

  // Refreshes ahead of expiry, so an HTTP call or a hub reconnect never sends an expired token.
  useEffect(() => {
    if (state.phase !== "signed-in") {
      return;
    }
    const session = readSession();
    const found = endpoints.current;
    if (!session || !found) {
      return;
    }
    const delay = Math.max(1_000, session.expiresAt - environment.now() - 60_000);
    const timer = globalThis.setTimeout(() => {
      void refreshSession(config, found, environment.fetcher, environment.now).then(
        () => setState({ phase: "signed-in" }),
        () => setState({ phase: "signed-out", message: "The session has ended. Sign in again." }),
      );
    }, delay);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [state, config, environment]);

  const signIn = () => {
    const found = endpoints.current;
    if (!found) {
      return;
    }
    const here = new URL(environment.href());
    void beginSignIn(config, found, environment.origin(), `${here.pathname}${here.search}`).then(
      (url) => environment.assign(url),
      (error: unknown) => setState({ phase: "signed-out", message: messageOf(error) }),
    );
  };

  const leave = () => {
    const found = endpoints.current;
    const url = found ? signOut(config, found, environment.origin()) : null;
    if (url) {
      environment.assign(url);
    } else {
      setState({ phase: "signed-out", message: null });
    }
  };

  switch (state.phase) {
    case "checking":
      return (
        <main className="key-gate">
          <output>Checking sign-in…</output>
        </main>
      );
    case "failed":
      return (
        <main className="key-gate">
          <h1>Sign-in unavailable</h1>
          <p role="alert">{state.message}</p>
        </main>
      );
    case "signed-out":
      return (
        <main className="key-gate">
          <h1 id="sign-in-title">Sign in</h1>
          <p>This dashboard is read-only. Sign in to view it. Your session stays in this tab until you close it or sign out.</p>
          {state.message !== null && (
            <p role="alert" className="field-help field-help-error">
              {state.message}
            </p>
          )}
          <div className="key-actions">
            <button type="button" onClick={signIn} aria-describedby="sign-in-title">
              Sign in
            </button>
          </div>
        </main>
      );
    case "signed-in":
      return (
        <>
          <button type="button" className="key-clear" onClick={leave}>
            Sign out
          </button>
          {children}
        </>
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
