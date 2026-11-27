import type { z } from "zod";

import type { LayoutSettings } from "../domain/layout.ts";
import { layoutDocumentSchema, type ServerLayout } from "../domain/layoutPersistence.ts";
import { readApiKey, reportUnauthorized } from "../lib/apiKey.ts";
import { DeadlineExceeded, performHttp } from "../lib/httpTransport.ts";
import { authConfigSchema, readAccessToken, type AuthConfig } from "../lib/oidc.ts";
import { currentApiBaseUrl, isNativeShell } from "../lib/serverUrl.ts";
import { instrumentSummariesSchema, type InstrumentSummary } from "./schemas.ts";

/** Why a call failed, in the categories the UI tells apart. */
export type ApiFailure = "network" | "timeout" | "unauthorized" | "forbidden" | "not-found" | "invalid" | "server" | "bad-response";

/** A failed API call. */
export class ApiError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure, message: string) {
    super(message);
    this.name = "ApiError";
    this.failure = failure;
  }
}

/** PUT /api/layouts/me answered 409. `document` is the layout the server still holds. */
export class LayoutConflictError extends Error {
  readonly document: ServerLayout;

  constructor(document: ServerLayout) {
    super(document.saved ? "The layout was saved from somewhere else." : "The server has no saved layout.");
    this.name = "LayoutConflictError";
    this.document = document;
  }
}

/** Extra control for one call. `reportUnauthorized` is false for the access probe, which handles 401 itself. */
export interface CallOptions {
  readonly reportUnauthorized?: boolean;
  /** A longer deadline for a call that waits on a model; the default is 8 s. */
  readonly timeoutMs?: number;
}

/** Turns a failed response into a typed error of the caller's own, or null to fall through to the generic failure. */
export type FailureReader = (response: Response) => Promise<Error | null>;

const TIMEOUT_MS = 8000;
const READ_RETRIES = 2;

function failureFor(status: number): ApiFailure {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 400 || status === 422) return "invalid";
  return "server";
}

function isTransient(error: unknown): boolean {
  return error instanceof ApiError && (error.failure === "network" || error.failure === "server");
}

function newCorrelationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function headersFor(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", "X-Correlation-Id": newCorrelationId() };
  const extra = init.headers;
  if (extra && typeof extra === "object" && !Array.isArray(extra) && !(extra instanceof Headers)) {
    for (const [name, value] of Object.entries(extra)) {
      if (typeof value === "string") {
        headers[name] = value;
      }
    }
  }
  // A signed-in tab sends its access token; otherwise the viewer key, if any (ARCHITECTURE.md D-30, D-77).
  const token = readAccessToken();
  const key = token ? null : readApiKey();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else if (key) {
    headers["X-Api-Key"] = key;
  }
  return headers;
}

export async function once<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit,
  signal?: AbortSignal,
  options?: CallOptions,
  conflict?: z.ZodType<ServerLayout>,
  readFailure?: FailureReader,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await performHttp({
      url: `${currentApiBaseUrl()}${path}`,
      init,
      headers: headersFor(init),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      callerSignal: signal,
      timeoutMs,
      native: isNativeShell(),
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw error instanceof DeadlineExceeded || timeout.aborted
      ? new ApiError("timeout", "The API did not answer in time.")
      : new ApiError("network", "The API could not be reached.");
  }
  if (!response.ok) {
    if (response.status === 409 && conflict) {
      const parsed = conflict.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new ApiError("bad-response", "The API's conflict answer did not match the expected shape.");
      }
      throw new LayoutConflictError(parsed.data);
    }
    if (response.status === 401 && options?.reportUnauthorized !== false) {
      reportUnauthorized();
    }
    const typed = readFailure ? await readFailure(response) : null;
    if (typed) {
      throw typed;
    }
    throw new ApiError(failureFor(response.status), `The API answered ${response.status}.`);
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ApiError("bad-response", "The API's answer did not match the expected shape.");
  }
  return parsed.data;
}

/** An idempotent read, retried with backoff on a network failure or a 5xx. A 401 is not retried. */
export async function read<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, options?: CallOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await once(path, schema, { method: "GET" }, signal, options);
    } catch (error) {
      if (attempt >= READ_RETRIES || !isTransient(error) || signal?.aborted) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * 3 ** attempt));
    }
  }
}

/** GET /api/instruments: the instruments this viewer may see, with their status. */
export function getInstruments(signal?: AbortSignal, options?: CallOptions): Promise<InstrumentSummary[]> {
  return read("/api/instruments", instrumentSummariesSchema, signal, options);
}

/** GET /api/auth/config: how this API signs viewers in, asked with no credential (ARCHITECTURE.md D-77). */
export function getAuthConfig(signal?: AbortSignal): Promise<AuthConfig> {
  return read("/api/auth/config", authConfigSchema, signal, { reportUnauthorized: false });
}

/** GET /api/layouts/me: the viewer's layout, and whether this process has a saved one. */
export function getLayout(signal?: AbortSignal): Promise<ServerLayout> {
  return read("/api/layouts/me", layoutDocumentSchema, signal);
}

/**
 * One GET /api/instruments with no retry. True only when the server answers 401.
 * The native hub cannot see that status on the socket, so a failed connect asks here.
 * `reportUnauthorized` stays false: the caller reports the rejection once.
 */
export async function viewerKeyRejected(signal?: AbortSignal): Promise<boolean> {
  try {
    await once("/api/instruments", instrumentSummariesSchema, { method: "GET" }, signal, { reportUnauthorized: false });
    return false;
  } catch (error) {
    return error instanceof ApiError && error.failure === "unauthorized";
  }
}

/** A layout to save. `positions` is left out unless the viewer changed them: the API then keeps the stored ones (REQUIREMENTS.md FR-72). */
export type LayoutPut = Omit<LayoutSettings, "positions"> & Partial<Pick<LayoutSettings, "positions">>;

/** PUT /api/layouts/me: saves the layout when `revision` is the one the server holds. A mismatch throws {@link LayoutConflictError}. Never retried automatically. */
export function putLayout(
  document: { readonly revision: number; readonly layout: LayoutPut },
  signal?: AbortSignal,
): Promise<ServerLayout> {
  return once(
    "/api/layouts/me",
    layoutDocumentSchema,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: document.revision, layout: document.layout }),
    },
    signal,
    undefined,
    layoutDocumentSchema,
  );
}
