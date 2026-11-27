// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { beginSignIn, readSession, useOidcStorage, type OidcClientConfig } from "../lib/oidc.ts";
import { SignInGate, type SignInGateEnvironment } from "./SignInGate.tsx";

// reference: ARCHITECTURE.md D-77
// A made-up provider at idp.example; no token here is signed.

const config: OidcClientConfig = { authority: "https://idp.example/realms/demo", clientId: "demo-dashboard", scope: "openid profile" };
const discovery = {
  issuer: "https://idp.example/realms/demo",
  authorization_endpoint: "https://idp.example/realms/demo/protocol/openid-connect/auth",
  token_endpoint: "https://idp.example/realms/demo/protocol/openid-connect/token",
  end_session_endpoint: "https://idp.example/realms/demo/protocol/openid-connect/logout",
};

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
}

function environment(href: string, assigned: string[] = [], replaced: string[] = []): SignInGateEnvironment {
  return {
    href: () => href,
    origin: () => "https://dashboard.example",
    replacePath: (path) => replaced.push(path),
    assign: (url) => assigned.push(url),
    fetcher: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = url.endsWith("/.well-known/openid-configuration") ? discovery : { access_token: "synthetic-access", expires_in: 300 };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    },
    now: () => Date.now(),
  };
}

describe("SignInGate", () => {
  const store = memory();

  beforeEach(() => {
    useOidcStorage(store.storage);
  });

  afterEach(() => {
    cleanup();
    useOidcStorage(null);
    store.values.clear();
  });

  it("should ask the viewer to sign in and keep the dashboard closed when the tab has no session", async () => {
    render(
      <SignInGate config={config} environment={environment("https://dashboard.example/")}>
        <p>dashboard</p>
      </SignInGate>,
    );

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("dashboard")).toBeNull();
  });

  it("should send the browser to the provider when the viewer presses Sign in", async () => {
    const assigned: string[] = [];
    render(
      <SignInGate config={config} environment={environment("https://dashboard.example/market/MES", assigned)}>
        <p>dashboard</p>
      </SignInGate>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    await expect.poll(() => assigned.length).toBe(1);
    expect(assigned[0]?.startsWith(discovery.authorization_endpoint)).toBe(true);
  });

  it("should open the dashboard and return to the page when the callback carries this tab's state", async () => {
    const started = new URL(
      await beginSignIn(
        config,
        { authorizationEndpoint: discovery.authorization_endpoint, tokenEndpoint: discovery.token_endpoint, endSessionEndpoint: null },
        "https://dashboard.example",
        "/market/MES",
      ),
    );
    const replaced: string[] = [];
    const callback = `https://dashboard.example/auth/callback?code=synthetic-code&state=${started.searchParams.get("state") ?? ""}`;

    render(
      <SignInGate config={config} environment={environment(callback, [], replaced)}>
        <p>dashboard</p>
      </SignInGate>,
    );

    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(replaced).toEqual(["/market/MES"]);
    expect(readSession()?.accessToken).toBe("synthetic-access");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("should say sign-in is unavailable when the provider cannot be reached", async () => {
    const unreachable: SignInGateEnvironment = { ...environment("https://dashboard.example/"), fetcher: () => Promise.reject(new Error("offline")) };

    render(
      <SignInGate config={config} environment={unreachable}>
        <p>dashboard</p>
      </SignInGate>,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Sign-in unavailable")).toBeTruthy();
  });
});
