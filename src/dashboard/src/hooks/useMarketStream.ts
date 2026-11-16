import { useEffect, useState, useSyncExternalStore } from "react";

import { hubKeyProbe } from "../api/hubKeyProbe.ts";
import { MarketStream, type StreamView } from "../api/marketStream.ts";
import { isNativeShell } from "../lib/serverUrl.ts";
import { createMarketConnection } from "../lib/signalr.ts";

/**
 * The live stream for one instrument: connects to the market hub on mount, subscribes to `instrument` with
 * `historyMinutes` of history and `indicatorMinutes` of indicator series (re-subscribing when any of them changes),
 * keeps the server told of the `watchlist` whose depth it should pull, and returns the current view. Chart interval
 * and the other layout choices are not arguments: changing them does not resubscribe.
 */
export function useMarketStream(
  instrument: string,
  historyMinutes: number,
  indicatorMinutes: number,
  watchlist: readonly string[],
): StreamView {
  const [stream] = useState(
    () => new MarketStream(createMarketConnection(), Date.now, undefined, hubKeyProbe(isNativeShell())),
  );

  useEffect(() => {
    stream.start();
    return () => stream.stop();
  }, [stream]);

  useEffect(() => {
    stream.select(instrument, historyMinutes, indicatorMinutes);
  }, [stream, instrument, historyMinutes, indicatorMinutes]);

  useEffect(() => {
    // The stream ignores a list equal to the one it already sent.
    stream.watch(watchlist);
  }, [stream, watchlist]);

  return useSyncExternalStore(stream.subscribe, stream.getView);
}
