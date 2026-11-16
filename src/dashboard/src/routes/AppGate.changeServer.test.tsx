// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, getInstruments } from "../api/client.ts";
import { ApiKeyGate } from "../components/ApiKeyGate.tsx";
import { OverviewTable } from "../components/OverviewTable.tsx";
import { clearApiKey, readApiKey, setApiKey, useApiKeyStorage } from "../lib/apiKey.ts";
import { ChangeServerContext } from "../lib/changeServer.ts";
import { ALLOW_CLEARTEXT_STORAGE_KEY, SERVER_BASE_STORAGE_KEY, readServerSettings, type KeyValueStore } from "../lib/serverUrl.ts";
import { AppGate } from "./AppGate.tsx";

vi.mock("../api/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client.ts")>();
  return { ...actual, getInstruments: vi.fn() };
});

function memoryStore(seed: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function keyStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function savedServer(base = "https://old.example"): KeyValueStore & { data: Record<string, string> } {
  return memoryStore({
    [SERVER_BASE_STORAGE_KEY]: base,
    [ALLOW_CLEARTEXT_STORAGE_KEY]: "false",
  });
}

function renderShell(store: KeyValueStore, reload: () => void = () => undefined) {
  return render(
    <AppGate native store={store} reload={reload}>
      <ApiKeyGate>
        <p>dashboard-body</p>
      </ApiKeyGate>
    </AppGate>,
  );
}

describe("AppGate change server", () => {
  afterEach(() => {
    cleanup();
    useApiKeyStorage(null);
    clearApiKey();
    vi.mocked(getInstruments).mockReset();
  });

  it("should offer Change server while access is still being checked, and open the form", async () => {
    useApiKeyStorage(keyStore());
    vi.mocked(getInstruments).mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();

    renderShell(savedServer());

    expect(screen.getByText("Checking access…")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Change server" }));

    expect(screen.getByLabelText("Server URL")).toBeTruthy();
    expect(screen.queryByText("Checking access…")).toBeNull();
  });

  it("should offer Change server when the saved server cannot be reached, and open the form", async () => {
    useApiKeyStorage(keyStore());
    vi.mocked(getInstruments).mockRejectedValue(new ApiError("network", "offline"));
    const user = userEvent.setup();

    renderShell(savedServer());

    expect(await screen.findByRole("heading", { name: "API unreachable" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Change server" }));

    expect(screen.getByLabelText("Server URL")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "API unreachable" })).toBeNull();
  });

  it("should offer Change server on the key prompt, and open the form", async () => {
    useApiKeyStorage(keyStore());
    vi.mocked(getInstruments).mockRejectedValue(new ApiError("unauthorized", "no key"));
    const user = userEvent.setup();

    renderShell(savedServer());

    expect(await screen.findByRole("heading", { name: "API key" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Change server" }));

    expect(screen.getByLabelText("Server URL")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "API key" })).toBeNull();
  });

  it("should clear the viewer key before it writes a different server", async () => {
    const events: string[] = [];
    const keys = keyStore();
    useApiKeyStorage({
      getItem: keys.getItem,
      setItem: (key, value) => {
        events.push("set-key");
        keys.setItem(key, value);
      },
      removeItem: (key) => {
        events.push("clear-key");
        keys.removeItem(key);
      },
    });
    setApiKey("synthetic-test-key");
    const store = savedServer();
    const recording: KeyValueStore = {
      getItem: store.getItem,
      setItem: (key, value) => {
        events.push(`write:${key}`);
        store.setItem(key, value);
      },
    };
    const reload = vi.fn();
    vi.mocked(getInstruments).mockRejectedValue(new ApiError("network", "offline"));
    const user = userEvent.setup();

    renderShell(recording, reload);
    await screen.findByRole("heading", { name: "API unreachable" });
    await user.click(screen.getByRole("button", { name: "Change server" }));
    const url = screen.getByLabelText("Server URL");
    await user.clear(url);
    await user.type(url, "https://new.example");
    await user.click(screen.getByRole("button", { name: "Save and reload" }));

    expect(reload).toHaveBeenCalledOnce();
    expect(readApiKey()).toBeNull();
    expect(readServerSettings(store).base).toBe("https://new.example");
    expect(events.indexOf("clear-key")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("clear-key")).toBeLessThan(events.indexOf(`write:${SERVER_BASE_STORAGE_KEY}`));
  });

  it("should keep the viewer key when the form saves the same server again", async () => {
    useApiKeyStorage(keyStore());
    setApiKey("synthetic-test-key");
    const store = savedServer("https://dashboard.example");
    const reload = vi.fn();
    vi.mocked(getInstruments).mockRejectedValue(new ApiError("network", "offline"));
    const user = userEvent.setup();

    renderShell(store, reload);
    await screen.findByRole("heading", { name: "API unreachable" });
    await user.click(screen.getByRole("button", { name: "Change server" }));
    await user.click(screen.getByRole("button", { name: "Save and reload" }));

    expect(reload).toHaveBeenCalledOnce();
    expect(readApiKey()).toBe("synthetic-test-key");
    expect(readServerSettings(store).base).toBe("https://dashboard.example");
  });

  it("should clear the viewer key when the form turns cleartext on for the same server", async () => {
    useApiKeyStorage(keyStore());
    setApiKey("synthetic-test-key");
    const store = savedServer("https://dashboard.example");
    const reload = vi.fn();
    vi.mocked(getInstruments).mockRejectedValue(new ApiError("network", "offline"));
    const user = userEvent.setup();

    renderShell(store, reload);
    await screen.findByRole("heading", { name: "API unreachable" });
    await user.click(screen.getByRole("button", { name: "Change server" }));
    await user.click(screen.getByRole("checkbox", { name: "Allow cleartext HTTP" }));
    await user.click(screen.getByRole("button", { name: "Save and reload" }));

    expect(reload).toHaveBeenCalledOnce();
    expect(readApiKey()).toBeNull();
    expect(readServerSettings(store).allowCleartext).toBe(true);
    expect(readServerSettings(store).base).toBe("https://dashboard.example");
  });
});

describe("Overview change server", () => {
  afterEach(() => {
    cleanup();
  });

  it("should offer Change server on Overview when the shell can edit the server", () => {
    render(
      <ChangeServerContext.Provider value={() => undefined}>
        <OverviewTable summaries={[]} watchlist={[]} active="MES" refused={[]} onOpen={() => undefined} onWatch={() => undefined} />
      </ChangeServerContext.Provider>,
    );

    expect(screen.getByRole("button", { name: "Change server" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /All products/ })).toBeTruthy();
  });

  it("should hide Change server on Overview in the browser", () => {
    render(<OverviewTable summaries={[]} watchlist={[]} active="MES" refused={[]} onOpen={() => undefined} onWatch={() => undefined} />);

    expect(screen.queryByRole("button", { name: "Change server" })).toBeNull();
  });
});
