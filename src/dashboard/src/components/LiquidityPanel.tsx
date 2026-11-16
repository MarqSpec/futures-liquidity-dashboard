import type { Liquidity } from "../api/schemas.ts";
import { formatPercent, formatQty, formatSigned, formatTicks, type TickSpec } from "../domain/format.ts";
import { SidePanel, type SideFold } from "./SidePanel.tsx";

/** Props of the liquidity summary. */
export interface LiquidityPanelProps {
  readonly liquidity: Liquidity;
  readonly spec: TickSpec;
  readonly fold?: SideFold;
}

/** Bid share of the resting size at the deepest summarised level, from the signed imbalance in [-1, 1]. */
function bidShare(depth: Liquidity["depth"]): number | null {
  const deepest = depth.at(-1)?.imbalance;
  return deepest == null || !Number.isFinite(deepest) ? null : Math.min(1, Math.max(0, (1 + deepest) / 2));
}

function Imbalance({ value }: { readonly value: number | null | undefined }) {
  const v = value ?? 0;
  const pct = Math.min(50, Math.abs(v) * 50);
  return (
    <span className="imbalance" title={formatPercent(value ?? null)}>
      <span className={v >= 0 ? "imbalance-bid" : "imbalance-ask"} style={v >= 0 ? { width: `${pct}%`, right: "50%" } : { width: `${pct}%`, left: "50%" }} />
    </span>
  );
}

/** The liquidity metrics of REQUIREMENTS.md FR-36–FR-40, compactly: top of book, depth imbalance, flows, delta, walls. */
export function LiquidityPanel({ liquidity: l, spec, fold }: LiquidityPanelProps) {
  const share = bidShare(l.depth);
  const signed = (value: number | null | undefined) => (value == null || value === 0 ? undefined : value > 0 ? "ld-up" : "ld-down");
  return (
    <SidePanel
      label="Liquidity metrics"
      fold={fold}
      title={
        <>
          Liquidity
          {share !== null && (
            <span className="ld-imbalance-read">
              <span className="ld-imbalance" aria-hidden="true">
                <span className="bid" style={{ width: `${share * 100}%` }} />
                <span className="ask" style={{ width: `${(1 - share) * 100}%` }} />
              </span>
              <span className="muted">
                <span className="visually-hidden">Bid share </span>
                {Math.round(share * 100)}/{Math.round((1 - share) * 100)}
              </span>
            </span>
          )}
        </>
      }
    >
      <dl className="ld-metrics">
        <dt>Bid</dt>
        <dd className="bid-text">
          {formatTicks(l.bestBid, spec)} × {formatQty(l.bestBidQuantity)}
        </dd>
        <dt>Ask</dt>
        <dd className="ask-text">
          {formatTicks(l.bestAsk, spec)} × {formatQty(l.bestAskQuantity)}
        </dd>
        <dt>Spread</dt>
        <dd>{l.spreadTicks ?? "—"} ticks</dd>
        <dt>Microprice</dt>
        <dd>{l.microprice != null && Number.isFinite(l.microprice) ? formatTicks(l.microprice, { ...spec, priceDecimals: spec.priceDecimals + 1 }) : "—"}</dd>
        <dt>Cum. delta</dt>
        <dd className={signed(l.cumulativeDelta)}>{formatSigned(l.cumulativeDelta)}</dd>
        <dt>Delta 60 s</dt>
        <dd className={signed(l.delta60s)}>{formatSigned(l.delta60s)}</dd>
        <dt>Trade rate</dt>
        <dd>{Number.isFinite(l.tradeRate) ? l.tradeRate.toFixed(1) : "—"}/s</dd>
        <dt>Session vol</dt>
        <dd>{formatQty(l.sessionVolume)}</dd>
      </dl>
      <table className="compact">
        <caption className="visually-hidden">Depth imbalance</caption>
        <thead>
          <tr>
            <th scope="col">Depth</th>
            <th scope="col">Bid</th>
            <th scope="col">Ask</th>
            <th scope="col">Imbalance</th>
          </tr>
        </thead>
        <tbody>
          {l.depth.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                book unknown
              </td>
            </tr>
          ) : (
            l.depth.map((d) => (
              <tr key={d.levels}>
                <th scope="row">{d.levels}</th>
                <td>{formatQty(d.bid)}</td>
                <td>{formatQty(d.ask)}</td>
                <td>
                  <Imbalance value={d.imbalance} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <table className="compact">
        <caption className="visually-hidden">Liquidity flow</caption>
        <thead>
          <tr>
            <th scope="col">Flow</th>
            <th scope="col">+add</th>
            <th scope="col">−pull</th>
            <th scope="col">fill</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ["bid 10s", l.flow10s.bidAdded, l.flow10s.bidPulled, l.flow10s.bidFilled],
              ["ask 10s", l.flow10s.askAdded, l.flow10s.askPulled, l.flow10s.askFilled],
              ["bid 60s", l.flow60s.bidAdded, l.flow60s.bidPulled, l.flow60s.bidFilled],
              ["ask 60s", l.flow60s.askAdded, l.flow60s.askPulled, l.flow60s.askFilled],
            ] as const
          ).map(([name, added, pulled, filled]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{formatQty(added)}</td>
              <td>{formatQty(pulled)}</td>
              <td>{formatQty(filled)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {l.walls.length > 0 && (
        <p className="small-text">
          Walls:{" "}
          {l.walls.map((w) => (
            <span key={`${w.side}${w.priceTicks}`} className={w.side === "Bid" ? "bid-text" : "ask-text"}>
              {formatTicks(w.priceTicks, spec)} ({formatQty(w.quantity)}, {Math.round(w.ageMs / 1000)} s){" "}
            </span>
          ))}
        </p>
      )}
    </SidePanel>
  );
}
