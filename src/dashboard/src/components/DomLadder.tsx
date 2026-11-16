import { formatQty, formatTicks } from "../domain/format.ts";
import type { MarketState } from "../domain/merge.ts";
import { recentOfKind } from "../domain/signals.ts";
import { SidePanel, type SideFold } from "./SidePanel.tsx";

/** Props of the depth ladder. */
export interface DomLadderProps {
  readonly market: MarketState;
  readonly isKindOn: (kind: string) => boolean;
  readonly fold?: SideFold;
}

const SPOOF_WINDOW_MS = 120_000;

interface Row {
  readonly price: number;
  readonly bid: number | null;
  readonly ask: number | null;
}

/**
 * The resting book around the inside: asks above, bids below, a size bar per level, the best bid and ask
 * highlighted, and iceberg (◆), recent spoof (◌) and wall (▮) markers at their prices. Read-only.
 */
export function DomLadder({ market, isKindOn, fold }: DomLadderProps) {
  const spec = market.instrument;
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
  const askRows: Row[] = [...asks].sort((a, b) => b[0] - a[0]).map(([price, qty]) => ({ price, bid: null, ask: qty }));
  const bidRows: Row[] = [...bids].sort((a, b) => b[0] - a[0]).map(([price, qty]) => ({ price, bid: qty, ask: null }));

  const renderRow = (row: Row) => {
    const best = row.price === bestBid || row.price === bestAsk;
    const ice = icebergs.get(row.price);
    const marks = [
      ice ? "◆" : "",
      spoofs.has(row.price) ? "◌" : "",
      walls.has(row.price) ? "▮" : "",
    ].join("");
    const title = [
      ice
        ? `inferred iceberg from prints and book changes, not exchange order ids: traded ${ice.traded}, peak shown ${ice.peakDisplayed}, ${ice.refills} refills, hidden ≥ ${ice.hiddenEstimate}`
        : "",
      spoofs.has(row.price) ? "spoof: size pulled on approach in the last 2 min" : "",
      walls.has(row.price) ? "wall: persistent large resting size" : "",
    ]
      .filter(Boolean)
      .join("; ");
    return (
      <tr key={`${row.bid === null ? "a" : "b"}${row.price}`} className={best ? "best" : undefined}>
        <td className="qty bid">
          {row.bid !== null && (
            <>
              <span className="bar bar-bid" style={{ width: `${(100 * row.bid) / max}%` }} />
              <span className="num">{formatQty(row.bid)}</span>
            </>
          )}
        </td>
        <td className={`price ${row.bid === null ? "ask-price" : "bid-price"}`}>{formatTicks(row.price, spec)}</td>
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
        <div className="ld-ladder-scroll">
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
        </div>
      )}
    </SidePanel>
  );
}
