import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type { EndedWall, Ladder } from "../api/schemas.ts";
import { formatQty, formatTicks } from "../domain/format.ts";
import type { MarketState } from "../domain/merge.ts";
import { recentOfKind } from "../domain/signals.ts";
import { endedWallTitle } from "../domain/walls.ts";
import { SidePanel, type SideFold } from "./SidePanel.tsx";

/** Props of the depth ladder. */
export interface DomLadderProps {
  readonly market: MarketState;
  readonly isKindOn: (kind: string) => boolean;
  readonly fold?: SideFold;
}

const SPOOF_WINDOW_MS = 120_000;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

interface Row {
  readonly price: number;
  readonly side: "bid" | "ask";
  readonly bid: number | null;
  readonly ask: number | null;
}

type Levels = Ladder["bids"];

/** Empty rows where an ended wall stood inside a side's shown range but no level rests now (REQUIREMENTS.md FR-78). */
function endedWallRows(prices: Iterable<number>, bids: Levels, asks: Levels): Row[] {
  const shown = new Set([...bids, ...asks].map((l) => l[0]));
  const inside = (price: number, levels: Levels) =>
    levels.length > 0 && price > Math.min(...levels.map((l) => l[0])) && price < Math.max(...levels.map((l) => l[0]));
  const rows: Row[] = [];
  for (const price of prices) {
    if (shown.has(price)) {
      continue;
    }
    if (inside(price, bids)) {
      rows.push({ price, side: "bid", bid: null, ask: null });
    } else if (inside(price, asks)) {
      rows.push({ price, side: "ask", bid: null, ask: null });
    }
  }
  return rows;
}

/**
 * The resting book around the inside: asks above, bids below, a size bar per level, the best bid and ask
 * highlighted, and iceberg (◆), recent spoof (◌), wall (▮) and ended-wall (▯) markers at their prices. An ended wall
 * whose level is gone gets an empty row, inside the shown range only. Read-only.
 */
export function DomLadder({ market, isKindOn, fold }: DomLadderProps) {
  const spec = market.instrument;
  const scrollRef = useRef<HTMLElement>(null);
  const written = useRef<number | null>(null);
  const [following, setFollowing] = useState(true);
  const { bids, asks } = market.ladder;
  const { bestBid, bestAsk, spreadTicks } = market.liquidity;
  const max = Math.max(1, ...bids.map((b) => b[1]), ...asks.map((a) => a[1]));
  const icebergs = new Map(isKindOn("Iceberg") ? market.orderFlow.icebergs.map((i) => [i.priceTicks, i]) : []);
  const spoofs = new Set(
    isKindOn("Spoof")
      ? recentOfKind(market.orderFlow.signals, "Spoof", market.serverTimeMs - SPOOF_WINDOW_MS).map((s) => s.priceTicks)
      : [],
  );
  const walls = new Set(market.liquidity.walls.map((w) => w.priceTicks));
  // Newest first from the server, so the first wall at a price is the latest to end there.
  const ended = new Map<number, EndedWall>();
  for (const wall of market.liquidity.endedWalls) {
    if (!ended.has(wall.priceTicks)) {
      ended.set(wall.priceTicks, wall);
    }
  }
  const gaps = endedWallRows(ended.keys(), bids, asks);
  const byPriceDown = (a: Row, b: Row) => b.price - a.price;
  const askRows: Row[] = [
    ...asks.map(([price, qty]): Row => ({
      price,
      side: "ask",
      bid: null,
      ask: qty,
    })),
    ...gaps.filter((r) => r.side === "ask"),
  ].sort(byPriceDown);
  const bidRows: Row[] = [
    ...bids.map(([price, qty]): Row => ({
      price,
      side: "bid",
      bid: qty,
      ask: null,
    })),
    ...gaps.filter((r) => r.side === "bid"),
  ].sort(byPriceDown);

  // Centre the spread row in the ladder's own box (never the page) before paint: one scroll write per update.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    const spread = box?.querySelector<HTMLElement>("tr.spread");
    if (!following || !box || !spread) {
      return;
    }
    const target = Math.max(0, Math.round(spread.offsetTop + spread.offsetHeight / 2 - box.clientHeight / 2));
    if (Math.abs(box.scrollTop - target) >= 1) {
      box.scrollTop = target;
    }
    // Record the position even when no write was needed: a browser that scroll-anchors the box has already put it at
    // the target, and the scroll event it sends must read as ours, not the viewer's.
    written.current = box.scrollTop;
  });

  // Our own write is told from a viewer's scroll by its position: only a scroll that lands elsewhere pauses following.
  const onScroll = () => {
    const box = scrollRef.current;
    if (box && (written.current === null || Math.abs(box.scrollTop - written.current) >= 1)) {
      setFollowing(false);
    }
  };

  // A scroll event lands about a frame after the scroll itself; a book update inside that gap would write the target back
  // and read the viewer's first scroll as ours. So the inputs that start a scroll pause following at once.
  const pause = () => setFollowing(false);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (SCROLL_KEYS.has(e.key)) {
      pause();
    }
  };

  const centre = () => {
    setFollowing(true);
    // The button is disabled once following resumes; keep keyboard focus on the ladder rather than losing it.
    scrollRef.current?.focus({ preventScroll: true });
  };

  const renderRow = (row: Row) => {
    const best = row.price === bestBid || row.price === bestAsk;
    const ice = icebergs.get(row.price);
    const gone = ended.get(row.price);
    const marks = [
      ice ? "◆" : "",
      spoofs.has(row.price) ? "◌" : "",
      walls.has(row.price) ? "▮" : "",
      gone ? "▯" : "",
    ].join("");
    const title = [
      ice
        ? `inferred iceberg from prints and book changes, not exchange order ids: traded ${ice.traded}, peak shown ${ice.peakDisplayed}, ${ice.refills} refills, hidden ≥ ${ice.hiddenEstimate}`
        : "",
      spoofs.has(row.price) ? "spoof: size pulled on approach in the last 2 min" : "",
      walls.has(row.price) ? "wall: persistent large resting size" : "",
      gone ? endedWallTitle(gone) : "",
    ]
      .filter(Boolean)
      .join("; ");
    return (
      <tr key={`${row.side === "ask" ? "a" : "b"}${row.price}`} className={best ? "best" : undefined}>
        <td className="qty bid">
          {row.bid !== null && (
            <>
              <span className="bar bar-bid" style={{ width: `${(100 * row.bid) / max}%` }} />
              <span className="num">{formatQty(row.bid)}</span>
            </>
          )}
        </td>
        <td className={`price ${row.side === "ask" ? "ask-price" : "bid-price"}`}>{formatTicks(row.price, spec)}</td>
        <td className="qty ask">
          {row.ask !== null && (
            <>
              <span className="bar bar-ask" style={{ width: `${(100 * row.ask) / max}%` }} />
              <span className="num">{formatQty(row.ask)}</span>
            </>
          )}
        </td>
        <td className="marks" title={title || undefined}>
          {marks}
        </td>
      </tr>
    );
  };

  return (
    <SidePanel
      label="Depth ladder"
      fold={fold}
      title={
        <>
          Depth
          {market.status.depthSubscribed && market.status.bookKnown ? (
            <span className="ld-dom-mark">DOM · {market.status.levelsPerSide}/side</span>
          ) : (
            <span className="muted">{!market.status.depthSubscribed ? "no depth" : "book unknown"}</span>
          )}
        </>
      }
    >
      {!market.status.depthSubscribed ? (
        <p className="muted">The server is not receiving depth for this product right now; trades and quotes only.</p>
      ) : !market.status.bookKnown ? (
        <p className="muted">The book is not known yet; no depth is shown rather than an empty book.</p>
      ) : (
        <>
          <button type="button" className="ld-ladder-centre" onClick={centre} disabled={following}>
            Centre
          </button>
          {/* A scrolling region is reached with Tab in every browser only when it takes focus itself. */}
          {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
          <section
            className="ld-ladder-scroll"
            ref={scrollRef}
            aria-label="Depth ladder levels"
            tabIndex={0}
            onScroll={onScroll}
            onWheel={pause}
            onKeyDown={onKeyDown}
            onPointerDown={pause}
          >
            {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
            <table className="ld-ladder">
              <thead>
                <tr>
                  <th scope="col">Bid</th>
                  <th scope="col">Price</th>
                  <th scope="col">Ask</th>
                  <th scope="col">
                    <span className="visually-hidden">Markers</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {askRows.map(renderRow)}
                <tr className="spread">
                  <td colSpan={4}>spread {spreadTicks ?? "—"} ticks</td>
                </tr>
                {bidRows.map(renderRow)}
              </tbody>
            </table>
          </section>
        </>
      )}
    </SidePanel>
  );
}
