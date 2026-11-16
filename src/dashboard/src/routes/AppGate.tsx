import { useState, type ReactNode } from "react";

import { ServerSettings } from "../components/ServerSettings.tsx";
import { config } from "../config.ts";
import { clearApiKey } from "../lib/apiKey.ts";
import { ChangeServerContext } from "../lib/changeServer.ts";
import {
  browserStore,
  isNativeShell,
  normalizeServerBase,
  readServerSettings,
  resolveServerEndpoint,
  saveServerSettings,
  serverChangeDropsApiKey,
  type KeyValueStore,
} from "../lib/serverUrl.ts";

/** Renders the server form on the native shell until a URL is saved, and a way back to it afterwards. */
export function AppGate({
  children,
  native = isNativeShell(),
  store,
  envBase = config.apiBaseUrl,
  reload = () => {
    globalThis.location.reload();
  },
}: {
  children: ReactNode;
  native?: boolean;
  store?: KeyValueStore;
  envBase?: string;
  reload?: () => void;
}) {
  const storage = store ?? browserStore();
  const stored = readServerSettings(storage);
  const active = resolveServerEndpoint({
    native,
    envBase,
    storedBase: stored.base,
    allowCleartext: stored.allowCleartext,
  });
  const [editing, setEditing] = useState(() => native && !active.configured);

  if (editing) {
    return (
      <ServerSettings
        initialBase={stored.base ?? ""}
        initialCleartext={stored.allowCleartext}
        onCancel={active.configured ? () => setEditing(false) : null}
        onSubmit={(base, allowCleartext) => {
          const previous = readServerSettings(storage);
          const parsed = normalizeServerBase(base, allowCleartext);
          if (!parsed.ok) {
            return parsed.error;
          }
          // Drop the key before either write. A failed second write must not leave the old key on the new origin.
          if (serverChangeDropsApiKey(previous, { apiBaseUrl: parsed.apiBaseUrl, allowCleartext })) {
            clearApiKey();
          }
          const saved = saveServerSettings(storage, base, allowCleartext);
          if (!saved.ok) {
            return saved.error;
          }
          reload();
          return null;
        }}
      />
    );
  }

  return <ChangeServerContext.Provider value={native ? () => setEditing(true) : null}>{children}</ChangeServerContext.Provider>;
}
