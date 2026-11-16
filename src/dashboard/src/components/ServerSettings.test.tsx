import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { useChangeServer } from "../lib/changeServer.ts";
import { AppGate } from "../routes/AppGate.tsx";
import { ALLOW_CLEARTEXT_STORAGE_KEY, SERVER_BASE_STORAGE_KEY, type KeyValueStore } from "../lib/serverUrl.ts";
import { ServerSettings } from "./ServerSettings.tsx";

function memoryStore(seed: Record<string, string> = {}): KeyValueStore {
  const data = { ...seed };
  return {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("ServerSettings", () => {
  it("should name the server field and warn that cleartext HTTP is unencrypted", () => {
    const html = renderToString(
      <ServerSettings initialBase="" initialCleartext={false} onSubmit={() => null} onCancel={null} />,
    );

    expect(html).toContain("Server URL");
    expect(html).toContain("Allow cleartext HTTP");
    expect(html).toContain("no encryption");
    expect(html).toContain("LAN");
    expect(html).toContain("does not store a key");
    expect(html).not.toContain(">Cancel<");
  });

  it("should offer cancel when a server is already saved", () => {
    const html = renderToString(
      <ServerSettings initialBase="https://dashboard.example" initialCleartext={false} onSubmit={() => null} onCancel={() => undefined} />,
    );
    expect(html).toContain(">Cancel<");
  });
});

function ChangeServerControl() {
  const changeServer = useChangeServer();
  if (!changeServer) {
    return null;
  }
  return (
    <button type="button" onClick={changeServer}>
      Change server
    </button>
  );
}

describe("AppGate", () => {
  it("should render the dashboard and no server form when the page is the browser", () => {
    const html = renderToString(
      <AppGate native={false} store={memoryStore({ [SERVER_BASE_STORAGE_KEY]: "https://phone.example" })}>
        <ChangeServerControl />
        <p>dashboard-body</p>
      </AppGate>,
    );
    expect(html).toContain("dashboard-body");
    expect(html).not.toContain("Server URL");
    expect(html).not.toContain("Change server");
  });

  it("should ask for a server URL before the dashboard when the shell has none", () => {
    const html = renderToString(
      <AppGate native store={memoryStore()}>
        <p>dashboard-body</p>
      </AppGate>,
    );
    expect(html).toContain("Server URL");
    expect(html).not.toContain("dashboard-body");
  });

  it("should show the dashboard and a way to change the server when the shell has a saved URL", () => {
    const html = renderToString(
      <AppGate
        native
        store={memoryStore({
          [SERVER_BASE_STORAGE_KEY]: "https://dashboard.example",
          [ALLOW_CLEARTEXT_STORAGE_KEY]: "false",
        })}
      >
        <ChangeServerControl />
        <p>dashboard-body</p>
      </AppGate>,
    );
    expect(html).toContain("dashboard-body");
    expect(html).toContain("Change server");
    expect(html).not.toContain("Server URL");
  });
});
