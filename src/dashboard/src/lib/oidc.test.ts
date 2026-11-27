import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authConfigSchema,
  beginSignIn,
  clearSession,
  codeChallenge,
  completeSignIn,
  discover,
  needsRefresh,
  readAccessToken,
  readSession,
  refreshSession,
  safeReturnPath,
  signOut,
  useOidcStorage,
  type OidcClientConfig,
  type OidcEndpoints,
} from "./oidc.ts";

// reference: ARCHITECTURE.md D-77
// Every value here is synthetic: a made-up provider at idp.example and tokens that are not signed.

const config: OidcClientConfig = { authority: "https://idp.example/realms/demo", clientId: "demo-dashboard", scope: "openid profile" };
const endpoints: OidcEndpoints = {
  authorizationEndpoint: "https://idp.example/realms/demo/protocol/openid-connect/auth",
  tokenEndpoint: "https://idp.example/realms/demo/protocol/openid-connect/token",
  endSessionEndpoint: "https://idp.example/realms/demo/protocol/openid-connect/logout",
};
const origin = "https://dashboard.example";

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

function unsignedJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${part({ alg: "none" })}.${part(payload)}.c2ln`;
}

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(answer: (url: string) => Response, calls: Call[] = []): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return Promise.resolve(answer(url));
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function startedSignIn(): Promise<URL> {
  return new URL(await beginSignIn(config, endpoints, origin, "/market/MES"));
}

describe("oidc", () => {
  const store = memory();

  beforeEach(() => {
    useOidcStorage(store.storage);
  });

  afterEach(() => {
    useOidcStorage(null);
    store.values.clear();
  });

  it("should encode the SHA-256 of the verifier as unpadded base64url when deriving the challenge", async () => {
    // Expected value from an independent implementation: base64.urlsafe_b64encode(sha256(verifier)) with "=" stripped.
    await expect(codeChallenge("dBjftJeZ4CVP-mJ92K9ylNJYwXNcjBKlZNmA7yn0O6o")).resolves.toBe("eTf5CJ4_VK6dSFG3c33a1HziLT9_iKhElpHyoqogXWc");
  });

  it("should accept a disabled config and an enabled one, and refuse a non-url authority", () => {
    expect(authConfigSchema.parse({ oidc: null }).oidc).toBeNull();
    expect(authConfigSchema.parse({ oidc: config }).oidc).toEqual(config);
    expect(authConfigSchema.safeParse({ oidc: { ...config, authority: "not a url" } }).success).toBe(false);
  });

  it("should build an S256 code request with state and nonce when sign-in starts", async () => {
    const url = await startedSignIn();

    expect(`${url.origin}${url.pathname}`).toBe(endpoints.authorizationEndpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("demo-dashboard");
    expect(url.searchParams.get("redirect_uri")).toBe("https://dashboard.example/auth/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("should trade the code with the verifier and store the session when the state matches", async () => {
    const started = await startedSignIn();
    const state = started.searchParams.get("state") ?? "";
    const nonce = started.searchParams.get("nonce") ?? "";
    const calls: Call[] = [];
    const fetcher = fakeFetch(
      () => json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token: unsignedJwt({ nonce }), expires_in: 300 }),
      calls,
    );

    const returnTo = await completeSignIn(`${origin}/auth/callback?code=synthetic-code&state=${state}`, config, endpoints, fetcher, () => 1_000);

    expect(returnTo).toBe("/market/MES");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(endpoints.tokenEndpoint);
    const form = new URLSearchParams(String(calls[0]?.init?.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("synthetic-code");
    expect(form.get("client_id")).toBe("demo-dashboard");
    expect(form.get("redirect_uri")).toBe("https://dashboard.example/auth/callback");
    expect(await codeChallenge(form.get("code_verifier") ?? "")).toBe(started.searchParams.get("code_challenge"));
    expect(readSession()).toEqual({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", idToken: unsignedJwt({ nonce }), expiresAt: 301_000 });
  });

  it("should refuse the callback and call no provider when the state does not match", async () => {
    await startedSignIn();
    const calls: Call[] = [];

    await expect(
      completeSignIn(`${origin}/auth/callback?code=synthetic-code&state=forged`, config, endpoints, fakeFetch(() => json({}), calls)),
    ).rejects.toThrow("not started from this tab");
    expect(calls).toHaveLength(0);
    expect(readSession()).toBeNull();
  });

  it("should refuse a second use of the same callback when the first one already ran", async () => {
    const started = await startedSignIn();
    const callback = `${origin}/auth/callback?code=synthetic-code&state=${started.searchParams.get("state") ?? ""}`;
    const fetcher = fakeFetch(() => json({ access_token: "synthetic-access" }));
    await completeSignIn(callback, config, endpoints, fetcher);

    await expect(completeSignIn(callback, config, endpoints, fetcher)).rejects.toThrow("not started from this tab");
  });

  it("should refuse the tokens when the ID token's nonce is another request's", async () => {
    const started = await startedSignIn();
    const fetcher = fakeFetch(() => json({ access_token: "synthetic-access", id_token: unsignedJwt({ nonce: "another" }) }));

    await expect(
      completeSignIn(`${origin}/auth/callback?code=c&state=${started.searchParams.get("state") ?? ""}`, config, endpoints, fetcher),
    ).rejects.toThrow("did not match");
    expect(readSession()).toBeNull();
  });

  it("should report a cancelled sign-in when the provider returns an error", async () => {
    await startedSignIn();

    await expect(completeSignIn(`${origin}/auth/callback?error=access_denied`, config, endpoints, fakeFetch(() => json({})))).rejects.toThrow(
      "cancelled",
    );
  });

  it("should send no token when the session has expired", () => {
    store.storage.setItem(
      "futures-liquidity-dashboard.oidc.session",
      JSON.stringify({ accessToken: "synthetic-access", refreshToken: null, idToken: null, expiresAt: 5_000 }),
    );

    expect(readAccessToken(4_000)).toBe("synthetic-access");
    expect(readAccessToken(5_000)).toBeNull();
  });

  it("should ask for a refresh within thirty seconds of expiry", () => {
    const session = { accessToken: "a", refreshToken: "r", idToken: null, expiresAt: 100_000 };

    expect(needsRefresh(session, 60_000)).toBe(false);
    expect(needsRefresh(session, 70_000)).toBe(true);
  });

  it("should keep the refresh token when the provider does not rotate it", async () => {
    store.storage.setItem(
      "futures-liquidity-dashboard.oidc.session",
      JSON.stringify({ accessToken: "old", refreshToken: "synthetic-refresh", idToken: null, expiresAt: 0 }),
    );
    const calls: Call[] = [];

    const next = await refreshSession(config, endpoints, fakeFetch(() => json({ access_token: "new", expires_in: 60 }), calls), () => 10_000);

    expect(next).toEqual({ accessToken: "new", refreshToken: "synthetic-refresh", idToken: null, expiresAt: 70_000 });
    expect(new URLSearchParams(String(calls[0]?.init?.body)).get("grant_type")).toBe("refresh_token");
  });

  it("should clear the session when the refresh is refused", async () => {
    store.storage.setItem(
      "futures-liquidity-dashboard.oidc.session",
      JSON.stringify({ accessToken: "old", refreshToken: "synthetic-refresh", idToken: null, expiresAt: 0 }),
    );

    await expect(refreshSession(config, endpoints, fakeFetch(() => json({ error: "invalid_grant" }, 400)))).rejects.toThrow("ended");
    expect(readSession()).toBeNull();
  });

  it("should accept a discovery document only when its issuer is the authority and its endpoints use https", async () => {
    const document = {
      issuer: "https://idp.example/realms/demo",
      authorization_endpoint: endpoints.authorizationEndpoint,
      token_endpoint: endpoints.tokenEndpoint,
      end_session_endpoint: endpoints.endSessionEndpoint,
    };

    await expect(discover(config.authority, fakeFetch(() => json(document)))).resolves.toEqual(endpoints);
    await expect(discover(config.authority, fakeFetch(() => json({ ...document, issuer: "https://evil.example" })))).rejects.toThrow(
      "different issuer",
    );
    await expect(
      discover(config.authority, fakeFetch(() => json({ ...document, token_endpoint: "http://idp.example/token" }))),
    ).rejects.toThrow("https");
  });

  it("should return only a same-origin path to open after sign-in", () => {
    expect(safeReturnPath("/market/MES?x=1")).toBe("/market/MES?x=1");
    expect(safeReturnPath("//evil.example/")).toBe("/");
    expect(safeReturnPath("https://evil.example/")).toBe("/");
    expect(safeReturnPath("/auth/callback?code=x")).toBe("/");
  });

  it("should clear the tokens and name the ID token when signing out", () => {
    store.storage.setItem(
      "futures-liquidity-dashboard.oidc.session",
      JSON.stringify({ accessToken: "a", refreshToken: "r", idToken: "synthetic-id", expiresAt: 1 }),
    );

    const url = new URL(signOut(config, endpoints, origin) ?? "");

    expect(url.searchParams.get("id_token_hint")).toBe("synthetic-id");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("https://dashboard.example/");
    expect(readSession()).toBeNull();
    clearSession();
  });
});
