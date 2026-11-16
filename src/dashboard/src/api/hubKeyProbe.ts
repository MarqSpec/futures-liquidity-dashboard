import { viewerKeyRejected } from "./client.ts";

/**
 * The browser hub reports 401 on negotiate. The native shell skips negotiate, so a failed socket
 * is checked with one REST call. The browser passes null and keeps the existing retry.
 */
export function hubKeyProbe(native: boolean): (() => Promise<boolean>) | null {
  return native ? () => viewerKeyRejected() : null;
}
