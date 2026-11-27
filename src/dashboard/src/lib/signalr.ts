import {
  HttpTransportType,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
  type HubConnection,
  type IHttpConnectionOptions,
  type ILogger,
  type RetryContext,
} from "@microsoft/signalr";

import { readApiKey } from "./apiKey.ts";
import { readAccessToken } from "./oidc.ts";
import { redactSecrets } from "./redactSecrets.ts";
import { currentHubUrl, isNativeShell } from "./serverUrl.ts";

/** The hub connection's state as the top bar shows it. */
export type HubState = "connecting" | "connected" | "reconnecting" | "disconnected";

/**
 * The market hub (INTERFACES.md Interface D.2) as the dashboard uses it: subscribe, unsubscribe, the
 * watchlist that decides which products the server pulls depth for, and the `delta` stream. Payloads come back as `unknown`; the caller parses them with zod. There is no method that trades.
 */
export interface MarketConnection {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(instrument: string, historyMinutes: number, indicatorMinutes: number): Promise<unknown>;
  unsubscribe(instrument: string): Promise<void>;
  /** Replaces this connection's watchlist; answers `{ depth, refused }`. */
  setWatchlist(instruments: readonly string[]): Promise<unknown>;
  onDelta(handler: (payload: unknown) => void): void;
  /** A catch-up snapshot the server pushes when this browser missed deltas (ARCHITECTURE.md D-32). */
  onSnapshot(handler: (payload: unknown) => void): void;
  onState(handler: (state: HubState, error: string | null) => void): void;
  state(): HubState;
}

/** Retries forever, backing off to 30 s, so a long API outage recovers on its own. */
export function reconnectDelayMs(previousRetryCount: number): number {
  return Math.min(30_000, 500 * 2 ** Math.min(previousRetryCount, 6));
}

/** A 401 from negotiate or the socket. The message still says 401 after the token text is redacted. */
export function isHubUnauthorized(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode?: unknown }).statusCode === 401) {
    return true;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\b401\b/.test(message);
}

/**
 * Delay before the next hub reconnect, or null to stop. A 401 means the key was rejected, so retrying would
 * leave the page on "reconnecting" after the key is rotated or revoked.
 */
export function nextReconnectDelay(context: RetryContext): number | null {
  return isHubUnauthorized(context.retryReason) ? null : reconnectDelayMs(context.previousRetryCount);
}

/** Keeps SignalR's own diagnostics off the console (CONVENTIONS.md §7); the UI shows the state instead. */
class SilentLogger implements ILogger {
  lastError: string | null = null;

  log(level: LogLevel, message: string): void {
    if (level >= LogLevel.Error) {
      this.lastError = redactSecrets(message);
    }
  }
}

function toHubState(state: HubConnectionState): HubState {
  switch (state) {
    case HubConnectionState.Connected:
      return "connected";
    case HubConnectionState.Reconnecting:
      return "reconnecting";
    case HubConnectionState.Connecting:
      return "connecting";
    case HubConnectionState.Disconnected:
    case HubConnectionState.Disconnecting:
      return "disconnected";
    default:
      return "disconnected";
  }
}

function errorText(error: unknown): string | null {
  return error instanceof Error ? redactSecrets(error.message) : null;
}

/**
 * SignalR options for the market hub. The key is an access token, not part of `url`: the client sends it as
 * `Authorization: Bearer` on negotiate and as `access_token` on the WebSocket. An empty token sends neither,
 * which is how Development's anonymous grants keep working. The native shell skips negotiate and uses the
 * WebSocket only; the factory still supplies `access_token`.
 */
export function marketHubOptions(
  readKey: () => string | null = readApiKey,
  native: boolean = isNativeShell(),
  readToken: () => string | null = readAccessToken,
): IHttpConnectionOptions {
  const options: IHttpConnectionOptions = {
    // A signed-in tab's access token wins over a viewer key (ARCHITECTURE.md D-77).
    accessTokenFactory: () => readToken() ?? readKey() ?? "",
  };
  if (native) {
    // The WebView origin is not the server, and the API sends no CORS headers. The socket still carries access_token.
    options.skipNegotiation = true;
    options.transport = HttpTransportType.WebSockets;
  }
  return options;
}

/**
 * Sets the indicator timeframe, then subscribes. The set has to finish first: SignalR counts arguments strictly,
 * so the timeframe is its own call, and the snapshot `Subscribe` returns must already be filtered to it.
 */
export async function openMarketSubscription(
  invoke: (method: string, ...args: readonly unknown[]) => Promise<unknown>,
  instrument: string,
  historyMinutes: number,
  indicatorMinutes: number,
): Promise<unknown> {
  await invoke("SetIndicatorTimeframe", instrument, indicatorMinutes);
  return invoke("Subscribe", instrument, historyMinutes);
}

/** Builds the market hub connection at `url` (WebSockets preferred, automatic reconnect). */
export function createMarketConnection(url: string = currentHubUrl()): MarketConnection {
  const logger = new SilentLogger();
  const connection: HubConnection = new HubConnectionBuilder()
    .withUrl(url, marketHubOptions())
    .withAutomaticReconnect({
      nextRetryDelayInMilliseconds: (context: RetryContext) => nextReconnectDelay(context),
    })
    .configureLogging(logger)
    .build();
  const stateHandlers: ((state: HubState, error: string | null) => void)[] = [];
  const emit = (state: HubState, error: string | null) => {
    for (const handler of stateHandlers) {
      handler(state, error);
    }
  };
  connection.onreconnecting((error) => emit("reconnecting", errorText(error)));
  connection.onreconnected(() => emit("connected", null));
  connection.onclose((error) => emit("disconnected", errorText(error) ?? logger.lastError));
  let stopping: Promise<void> | null = null;

  return {
    async start() {
      if (stopping) {
        // React's StrictMode stops and restarts at once in development; a start must wait for the stop.
        await stopping;
      }
      if (connection.state !== HubConnectionState.Disconnected) {
        return;
      }
      emit("connecting", null);
      try {
        await connection.start();
        emit("connected", null);
      } catch (error) {
        emit("disconnected", errorText(error) ?? logger.lastError);
        throw error;
      }
    },
    stop() {
      const current: Promise<void> = connection.stop().finally(() => {
        if (stopping === current) {
          stopping = null;
        }
      });
      stopping = current;
      return current;
    },
    subscribe: (instrument, historyMinutes, indicatorMinutes) =>
      openMarketSubscription(
        (method, ...args) => connection.invoke(method, ...args),
        instrument,
        historyMinutes,
        indicatorMinutes,
      ),
    unsubscribe: (instrument) => connection.invoke<void>("Unsubscribe", instrument),
    setWatchlist: (instruments) => connection.invoke<unknown>("SetWatchlist", [...instruments]),
    onDelta(handler) {
      // A block body: a handler that returns a value is taken by SignalR as a client result and logged as an error.
      connection.on("delta", (payload: unknown) => {
        handler(payload);
      });
    },
    onSnapshot(handler) {
      connection.on("snapshot", (payload: unknown) => {
        handler(payload);
      });
    },
    onState(handler) {
      stateHandlers.push(handler);
    },
    state: () => toHubState(connection.state),
  };
}
