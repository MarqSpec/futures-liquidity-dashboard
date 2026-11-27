import { z } from "zod";

// reference: ARCHITECTURE.md D-77
// Sign-in through an OpenID Connect provider: the Authorization Code flow with PKCE (RFC 7636), as a public client with no
// secret. The API decides what a signed-in user may do; the browser only carries the access token. Tokens live in
// sessionStorage, like the viewer key (D-30): kept across a reload, dropped when the tab closes, never in a VITE_* value.

/** GET /api/auth/config. `oidc` is null when sign-in is off and the browser asks for an API key instead. */
export const authConfigSchema = z.object({
  oidc: z
    .object({
      authority: z.url(),
      clientId: z.string().min(1),
      scope: z.string().min(1),
    })
    .nullable(),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;
export type OidcClientConfig = NonNullable<AuthConfig["oidc"]>;

const discoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  end_session_endpoint: z.url().optional(),
});

/** The endpoints the flow uses, from the provider's discovery document. */
export type OidcEndpoints = {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly endSessionEndpoint: string | null;
};

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
});

/** What a signed-in tab holds. `expiresAt` is epoch milliseconds. */
export type OidcSession = {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAt: number;
};

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().nullable(),
  idToken: z.string().nullable(),
  expiresAt: z.number(),
});

const pendingSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  verifier: z.string().min(43),
  returnTo: z.string(),
});

type Pending = z.infer<typeof pendingSchema>;

/** The path the provider redirects back to. Register `<origin>/auth/callback` as the client's redirect URI. */
export const CALLBACK_PATH = "/auth/callback";

const SESSION_KEY = "futures-liquidity-dashboard.oidc.session";
const PENDING_KEY = "futures-liquidity-dashboard.oidc.pending";
/** A token this close to expiry is refreshed before it is sent. */
export const REFRESH_MARGIN_MS = 30_000;
/** Used when the provider leaves out `expires_in`. */
const DEFAULT_LIFETIME_S = 300;

/** A sign-in step that failed. The message is safe to show: it never contains a code or a token. */
export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const memory = new Map<string, string>();
const memoryStore: Store = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
  },
  removeItem: (key) => {
    memory.delete(key);
  },
};

let replacement: Store | null = null;

function store(): Store {
  if (replacement) {
    return replacement;
  }
  try {
    const session = globalThis.sessionStorage;
    if (session) {
      return session;
    }
  } catch {
    // A private window that blocks site data: keep the session for this page only.
  }
  return memoryStore;
}

/** Tests substitute the store. Pass null to use sessionStorage or memory again. */
export function useOidcStorage(next: Store | null): void {
  replacement = next;
}

function readJson<T>(key: string, schema: z.ZodType<T>): T | null {
  const raw = store().getItem(key);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The stored session, or null when this tab has not signed in. An expired session is still returned, for its refresh token. */
export function readSession(): OidcSession | null {
  return readJson(SESSION_KEY, sessionSchema);
}

function writeSession(session: OidcSession): void {
  store().setItem(SESSION_KEY, JSON.stringify(session));
}

/** Forgets this tab's tokens. */
export function clearSession(): void {
  store().removeItem(SESSION_KEY);
}

/** The access token to send now, or null when there is none or it has expired. */
export function readAccessToken(now: number = Date.now()): string | null {
  const session = readSession();
  return session && session.expiresAt > now ? session.accessToken : null;
}

/** True when the session should be refreshed before its token is sent again. */
export function needsRefresh(session: OidcSession, now: number = Date.now()): boolean {
  return session.expiresAt - now <= REFRESH_MARGIN_MS;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return base64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The S256 code challenge for `verifier` (RFC 7636 §4.2). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function isAllowedEndpoint(raw: string): boolean {
  const url = new URL(raw);
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/**
 * Reads the provider's discovery document. Its issuer must be the configured authority, and every endpoint https
 * (or loopback http for a local provider), so a tampered document cannot send the code anywhere else.
 */
export async function discover(authority: string, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<OidcEndpoints> {
  const base = authority.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetcher(`${base}/.well-known/openid-configuration`, { headers: { Accept: "application/json" } });
  } catch {
    throw new OidcError("The sign-in provider could not be reached.");
  }
  if (!response.ok) {
    throw new OidcError("The sign-in provider did not answer.");
  }
  const parsed = discoverySchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new OidcError("The sign-in provider's settings were not readable.");
  }
  const doc = parsed.data;
  if (doc.issuer.replace(/\/+$/, "") !== base) {
    throw new OidcError("The sign-in provider names a different issuer.");
  }
  const endpoints = [doc.authorization_endpoint, doc.token_endpoint, doc.end_session_endpoint].filter((e): e is string => e !== undefined);
  if (!endpoints.every(isAllowedEndpoint)) {
    throw new OidcError("The sign-in provider's endpoints must use https.");
  }
  return {
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    endSessionEndpoint: doc.end_session_endpoint ?? null,
  };
}

/** The redirect URI for this page's origin. */
export function redirectUri(origin: string = globalThis.location.origin): string {
  return `${origin}${CALLBACK_PATH}`;
}

/**
 * Remembers a fresh state, nonce and verifier for this tab and returns the provider URL to send the browser to.
 * `returnTo` is the same-origin path to open once signed in.
 */
export async function beginSignIn(config: OidcClientConfig, endpoints: OidcEndpoints, origin: string, returnTo: string): Promise<string> {
  const pending: Pending = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), returnTo: safeReturnPath(returnTo) };
  store().setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri(origin));
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", pending.state);
  url.searchParams.set("nonce", pending.nonce);
  url.searchParams.set("code_challenge", await codeChallenge(pending.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** A same-origin path only: anything else, or the callback itself, opens the dashboard's root. */
export function safeReturnPath(raw: string): string {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.startsWith(CALLBACK_PATH)) {
    return "/";
  }
  return raw;
}

function payloadOf(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) {
    return null;
  }
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function requestTokens(tokenEndpoint: string, form: URLSearchParams, fetcher: typeof fetch): Promise<z.infer<typeof tokenResponseSchema>> {
  let response: Response;
  try {
    response = await fetcher(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
  } catch {
    throw new OidcError("The sign-in provider could not be reached.");
  }
  if (!response.ok) {
    throw new OidcError("The sign-in provider refused the request.");
  }
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new OidcError("The sign-in provider's answer was not readable.");
  }
  return parsed.data;
}

function sessionFrom(tokens: z.infer<typeof tokenResponseSchema>, now: number, previousRefresh: string | null): OidcSession {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefresh,
    idToken: tokens.id_token ?? null,
    expiresAt: now + (tokens.expires_in ?? DEFAULT_LIFETIME_S) * 1000,
  };
}

/**
 * Finishes a sign-in from the callback URL: checks the state, trades the code and verifier for tokens, checks the ID
 * token's nonce, and stores the session. Returns the path to open. The pending values are cleared whatever happens,
 * so a code is never traded twice.
 */
export async function completeSignIn(
  callbackUrl: string,
  config: OidcClientConfig,
  endpoints: OidcEndpoints,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  now: () => number = Date.now,
): Promise<string> {
  const pending = readJson(PENDING_KEY, pendingSchema);
  store().removeItem(PENDING_KEY);
  const url = new URL(callbackUrl);
  if (url.searchParams.has("error")) {
    throw new OidcError("Sign-in was cancelled or refused.");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!pending || !code || !state || state !== pending.state) {
    throw new OidcError("This sign-in was not started from this tab. Sign in again.");
  }
  const tokens = await requestTokens(
    endpoints.tokenEndpoint,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(url.origin),
      client_id: config.clientId,
      code_verifier: pending.verifier,
    }),
    fetcher,
  );
  if (tokens.id_token && payloadOf(tokens.id_token)?.["nonce"] !== pending.nonce) {
    throw new OidcError("The sign-in answer did not match this request. Sign in again.");
  }
  writeSession(sessionFrom(tokens, now(), null));
  return pending.returnTo;
}

/** Trades the refresh token for a new access token. Clears the session and throws when there is none or it is refused. */
export async function refreshSession(
  config: OidcClientConfig,
  endpoints: OidcEndpoints,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  now: () => number = Date.now,
): Promise<OidcSession> {
  const session = readSession();
  if (!session?.refreshToken) {
    clearSession();
    throw new OidcError("The session has ended. Sign in again.");
  }
  try {
    const tokens = await requestTokens(
      endpoints.tokenEndpoint,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: config.clientId }),
      fetcher,
    );
    const next = sessionFrom(tokens, now(), session.refreshToken);
    writeSession(next);
    return next;
  } catch {
    clearSession();
    throw new OidcError("The session has ended. Sign in again.");
  }
}

/** The provider's sign-out URL for this session, or null when it publishes none. Clears this tab's tokens either way. */
export function signOut(config: OidcClientConfig, endpoints: OidcEndpoints, origin: string): string | null {
  const idToken = readSession()?.idToken ?? null;
  clearSession();
  if (!endpoints.endSessionEndpoint) {
    return null;
  }
  const url = new URL(endpoints.endSessionEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("post_logout_redirect_uri", `${origin}/`);
  if (idToken) {
    url.searchParams.set("id_token_hint", idToken);
  }
  return url.toString();
}
