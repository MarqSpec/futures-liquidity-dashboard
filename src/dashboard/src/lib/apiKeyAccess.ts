import { clearApiKey, readApiKey, setApiKey } from "./apiKey.ts";

/** What a probe of GET /api/instruments told us. */
export type ProbeResult = "ok" | "unauthorized" | "unreachable";

/** The next step after one probe. */
export type AccessStep =
  | { readonly action: "open" }
  | { readonly action: "drop-key-and-retry" }
  | { readonly action: "prompt"; readonly reason: "missing" | "rejected" }
  | { readonly action: "unreachable" };

/** What the gate shows once a probe has settled. */
export type SettledAccess =
  | { readonly phase: "open" }
  | { readonly phase: "prompt"; readonly reason: "missing" | "rejected" }
  | { readonly phase: "unreachable" };

/**
 * Decides the next step. A stored key that the server rejects is dropped and tried once without a key, so
 * Development's anonymous grants still open the dashboard. A key the viewer just typed is not silently dropped:
 * they see that it was rejected.
 */
export function afterProbe(hadKey: boolean, explicitSubmit: boolean, result: ProbeResult): AccessStep {
  switch (result) {
    case "ok":
      return { action: "open" };
    case "unreachable":
      return { action: "unreachable" };
    case "unauthorized":
      if (hadKey && !explicitSubmit) {
        return { action: "drop-key-and-retry" };
      }
      return { action: "prompt", reason: hadKey ? "rejected" : "missing" };
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

function settled(step: AccessStep): SettledAccess {
  switch (step.action) {
    case "open":
      return { phase: "open" };
    case "unreachable":
      return { phase: "unreachable" };
    case "prompt":
      return { phase: "prompt", reason: step.reason };
    case "drop-key-and-retry":
      return { phase: "prompt", reason: "missing" };
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

/**
 * Probes with the stored key, or with `explicit` when the viewer just submitted one. A rejected stored key is
 * cleared and the probe runs once more with no key.
 */
export async function settleAccess(explicit: string | null, probe: () => Promise<ProbeResult>): Promise<SettledAccess> {
  if (explicit !== null) {
    setApiKey(explicit);
  }
  const sentKey = readApiKey() !== null;
  const first = afterProbe(sentKey, explicit !== null, await probe());
  if (first.action === "drop-key-and-retry") {
    clearApiKey();
    return settled(afterProbe(false, false, await probe()));
  }
  if (first.action === "prompt") {
    clearApiKey();
  }
  return settled(first);
}
