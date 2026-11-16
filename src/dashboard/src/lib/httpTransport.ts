// Capacitor's fetch patch sends GET, HEAD, OPTIONS and TRACE through the WebView, which honors
// AbortSignal. PUT, POST, PATCH and DELETE go to CapacitorHttp without the signal and without a
// timeout, so a layout save could wait forever. Those calls set connectTimeout and readTimeout,
// and every call also races a timer so a transport that ignores abort still settles.

/** The patched fetch ignores AbortSignal for this method. */
export function capacitorFetchIgnoresAbort(method: string): boolean {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "TRACE":
      return false;
    default:
      return true;
  }
}

/** A native write. Both timeouts are the call's deadline, in milliseconds. */
export interface NativeHttpCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly data?: string;
  readonly connectTimeout: number;
  readonly readTimeout: number;
}

/** What CapacitorHttp.request resolves to. JSON bodies may already be parsed. */
export interface NativeHttpResult {
  readonly status: number;
  readonly data: unknown;
  readonly headers: Record<string, string>;
}

export type NativeHttp = (call: NativeHttpCall) => Promise<NativeHttpResult>;

/** The request exceeded its deadline. The caller maps this to a timeout. */
export class DeadlineExceeded extends Error {
  constructor() {
    super("The request exceeded its deadline.");
    this.name = "DeadlineExceeded";
  }
}

let nativeHttp: NativeHttp | null = null;

/** Test seam. Production uses CapacitorHttp.request. */
export function useNativeHttp(request: NativeHttp | null): void {
  nativeHttp = request;
}

/** The options a native write sends. Both timeouts are `timeoutMs`. */
export function buildNativeHttpCall(url: string, init: RequestInit, headers: Record<string, string>, timeoutMs: number): NativeHttpCall {
  return {
    url,
    method: (init.method ?? "GET").toUpperCase(),
    headers,
    data: typeof init.body === "string" ? init.body : undefined,
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
  };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Resolves with `work`, or rejects when `timeoutMs` elapses or `caller` aborts.
 * A transport that never observes `caller` still stops the caller at the deadline.
 */
export function settleWithin<T>(work: Promise<T>, timeoutMs: number, caller?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (caller?.aborted) {
      reject(caller.reason ?? abortError());
      void work.then(
        () => undefined,
        () => undefined,
      );
      return;
    }
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(caller?.reason ?? abortError()));
    const timer = setTimeout(() => finish(() => reject(new DeadlineExceeded())), timeoutMs);
    caller?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function responseFromNative(result: NativeHttpResult): Response {
  const headers = new Headers(result.headers);
  if (result.status === 204 || result.data == null) {
    return new Response(null, { status: result.status, headers });
  }
  const body = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  return new Response(body, { status: result.status, headers });
}

async function capacitorRequest(call: NativeHttpCall): Promise<NativeHttpResult> {
  const { CapacitorHttp } = await import("@capacitor/core");
  const response = await CapacitorHttp.request({
    url: call.url,
    method: call.method,
    headers: call.headers,
    data: call.data,
    connectTimeout: call.connectTimeout,
    readTimeout: call.readTimeout,
    responseType: "text",
  });
  return { status: response.status, data: response.data, headers: response.headers };
}

/** One HTTP call. A native write uses CapacitorHttp's timeouts; every call also races `timeoutMs`. */
export function performHttp(input: {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly callerSignal?: AbortSignal;
  readonly timeoutMs: number;
  readonly native: boolean;
}): Promise<Response> {
  const method = (input.init.method ?? "GET").toUpperCase();
  const work =
    input.native && capacitorFetchIgnoresAbort(method)
      ? (nativeHttp ?? capacitorRequest)(buildNativeHttpCall(input.url, input.init, input.headers, input.timeoutMs)).then(responseFromNative)
      : fetch(input.url, { ...input.init, headers: input.headers, signal: input.signal });
  return settleWithin(work, input.timeoutMs, input.callerSignal);
}
