import { useEffect, useRef, useState, type ReactNode } from "react";

import { ApiError, getInstruments } from "../api/client.ts";
import { clearApiKey, readApiKey, subscribeUnauthorized } from "../lib/apiKey.ts";
import { settleAccess, type ProbeResult, type SettledAccess } from "../lib/apiKeyAccess.ts";
import { ApiKeyPrompt } from "./ApiKeyPrompt.tsx";
import { ChangeServerButton } from "./ChangeServerButton.tsx";

type GateState = { readonly phase: "checking" } | SettledAccess;

async function probe(signal: AbortSignal): Promise<ProbeResult> {
  try {
    await getInstruments(signal, { reportUnauthorized: false });
    return "ok";
  } catch (error) {
    if (signal.aborted) {
      return "unreachable";
    }
    return error instanceof ApiError && error.failure === "unauthorized" ? "unauthorized" : "unreachable";
  }
}

/**
 * Opens the dashboard when the API allows this caller. Development's anonymous grants need no prompt. Any other
 * 401 asks for a key, and a later 401 asks again. The key is kept for this tab only (ARCHITECTURE.md D-30).
 */
export function ApiKeyGate({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<GateState>({ phase: "checking" });
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    inflight.current = controller;
    let active = true;
    void settleAccess(null, () => probe(controller.signal)).then((next) => {
      if (active) {
        setState(next);
      }
    });
    const stop = subscribeUnauthorized(() => {
      clearApiKey();
      if (active) {
        setState({ phase: "prompt", reason: "rejected" });
      }
    });
    return () => {
      active = false;
      controller.abort();
      stop();
    };
  }, []);

  const start = (explicit: string | null) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setState({ phase: "checking" });
    void settleAccess(explicit, () => probe(controller.signal)).then((next) => {
      if (inflight.current === controller) {
        setState(next);
      }
    });
  };

  const clear = () => {
    clearApiKey();
    start(null);
  };

  if (state.phase === "checking") {
    return (
      <main className="key-gate">
        <ChangeServerButton />
        <output>Checking access…</output>
      </main>
    );
  }

  if (state.phase === "unreachable") {
    return (
      <main className="key-gate">
        <ChangeServerButton />
        <h1>API unreachable</h1>
        <p role="alert">The API could not be reached.</p>
        <button type="button" onClick={() => start(null)}>
          Retry
        </button>
      </main>
    );
  }

  if (state.phase === "prompt") {
    return (
      <>
        <ChangeServerButton />
        <ApiKeyPrompt reason={state.reason} onSubmit={(key) => start(key)} onClear={clear} />
      </>
    );
  }

  return (
    <>
      {readApiKey() !== null && (
        <button type="button" className="key-clear" onClick={clear}>
          Clear API key
        </button>
      )}
      {children}
    </>
  );
}
