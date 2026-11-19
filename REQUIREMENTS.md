# Requirements

What the Live Futures Liquidity Dashboard was built to do, and for whom. Use cases are `UC-n`, functional
requirements `FR-n` and non-functional requirements `NFR-n`; the code cites these IDs. Each requirement's status
says what the code does today: **Built**, **Partial** (built and tested, with a target still unmeasured or a part
missing) or **Proposed** (not built). The design decisions behind them are the `D-n` entries in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. Purpose

A read-only web view of **resting liquidity next to actual price movement** for one futures instrument at a time:
any product the feed offers, with MES, MCL and MGC as the default favorites and an Overview of all of them (FR-54,
FR-57). Resting bid and ask quantity is drawn as a heatmap behind the price on one shared interval (1, 2, 5 or 15
minutes, rebuilt from retained one-second slices and one-minute columns). Volume dots are the default price mark,
with candles as an option (FR-58–FR-61). An Order Flow tab keeps that reading on one price scale with a docked
book, the indicator dock Detail shows, a failed-reclaim marker and a read-only trail guide (FR-65–FR-67). Visible history runs from
30 minutes to three days. A viewer may also draw one **simulated position** per product (an entry, a stop and up to
three targets), watch it tracked against the live prints, and ask for advisory feedback on it; it stays on the
dashboard and is never sent anywhere as an order (FR-72–FR-74).

Trend, momentum and volatility indicators, a multi-day volume profile and an order-flow layer (footprint bars,
delta and CVD, and signals such as icebergs, pulled liquidity and inferred sweeps) share the price axis but run on
their own clocks, so changing the visible window never changes them. An asynchronous agent may add dated,
advisory levels and context. The client is a desktop browser (or an installed PWA) fed by one ASP.NET Core service
over SignalR.

**The problem.** Periodic quote dashboards cannot show how liquidity persists, moves or disappears alongside
second-scale price action, and tools that tie indicators and session context to the chart window distort both.

**Principles.**

- **P1. A trustworthy view, not a trading system.** No order path exists anywhere (FR-6). Nothing claims that
  liquidity predicts movement. An order-flow signal is a fact about what the feed showed, never a recommendation,
  and nothing acts on it. A simulated position is an annotation, and its feedback is commentary on measured
  figures, never an instruction.
- **P2. Unknown is never drawn as known.** Coverage, freshness, readiness and provenance are always visible.
  Unavailable depth is never shown as zero, gaps are never filled forward, and simulated or recorded data is never
  shown as live (FR-4, FR-11, FR-12).
- **P3. Independent clocks.** Display interval, visible history, each indicator, the VWAP anchor, the profile
  window, the footprint bar length, agent context and render cadence are separate settings (FR-2).
- **P4. Instruments stand alone.** Every product keeps its own book, bars, indicators, profile, order-flow state,
  regime, session calendar and active contract. They are read in detail one at a time and never merged (FR-5,
  FR-10). The Overview lists one summary row per product, which merges nothing (FR-57).
- **P5 (provisional). Live depth depends on evidence.** An instrument's live heatmap is trusted only after a check
  against the real account proves depth entitlement, event semantics and recovery (D-1).
- **P6 (provisional). Detector thresholds are starting points.** Every order-flow threshold and window
  (FR-41–FR-52) is configurable and every detector can be switched off. The defaults were chosen for one-minute
  footprints on MES, MCL and MGC.

**Terms.** *Heat intensity* is resting contract quantity at a price, not a count of orders. The *volume profile* is
executed contracts at each price; cancellations never count as volume. *Coverage* is the fraction of a time slice or
price range for which the book was actually known. An *epoch* is one unbroken upstream connection. The *aggressor*
is the side that crossed the spread. *Delta* is buy-aggressor minus sell-aggressor volume; *CVD* is delta
accumulated over the session. A *footprint* is a bar that keeps bid × ask executed volume at every price. A *key
level* is a price the market reacts to: prior and current session high and low, swing pivots, VWAP and the value-area
edges. *Provenance* is where events come from: LIVE, REPLAY or SIMULATED.

## 2. Users and permissions

A user is a person or a program holding a set of **permissions**, each granted with a **scope**: an instrument root
(`ES`, `MGC`, …) or `*` for all, written `permission:scope` (for example `publish-overlay:ES`). Grants are not
inherited: only that exact permission, for that root or `*`, counts. No permission places, changes or cancels an
order (FR-6). How a caller proves who it is: API keys (D-16).

| Permission | Allows |
|---|---|
| `view-dashboard` | Open the dashboard for instruments in scope and read the chart, indicators, profile, liquidity, order flow, status and overlays (UC-1–UC-7, UC-13–UC-17) |
| `configure-layout` | Change and save the caller's own layout (UC-2, UC-8, UC-14, UC-15) |
| `publish-overlay` | Publish a versioned overlay of levels and context for instruments in scope (UC-5). No access to raw market data or credentials |
| `read-context` | Read the analytics snapshot an agent needs to write an overlay (UC-5) |
| `request-feedback` | Ask for feedback on a simulated position for instruments in scope, and read whether feedback is available and the month's spend against its cap (UC-20, FR-74). Each request may cost money, so it is a grant of its own: anonymous in Development only, and outside it only on keys given it. It grants nothing else; the reply carries the position's metrics, so asking also needs `view-dashboard` on the instrument |

| ID | User | Typically holds |
|---|---|---|
| U-1 | The trader reading MES, MCL and MGC | `view-dashboard:*`, `configure-layout:*`, `request-feedback:*` |
| U-2 | A context agent: the built-in reference agent (D-17) or an external program with a key | `read-context:*`, `publish-overlay:*` |

## 3. Use cases

| ID | As a… | I want to… | So that… |
|---|---|---|---|
| UC-1 | Trader | compare resting bid/ask quantity at each price with executed price over matching slices | I see how liquidity persists, moves or disappears as price moves |
| UC-2 | Trader | change visible history or display interval without changing any indicator, VWAP anchor or profile | the analytics I rely on do not shift when I zoom |
| UC-3 | Trader | inspect an exact price/time cell and tell known zero liquidity from unavailable depth | I never read a data gap as an empty book |
| UC-4 | Trader | recognise a stale feed, a partial profile, a developing indicator, or simulated or replayed data | I know when not to rely on what I see |
| UC-5 | Trader; context agent | see dated agent levels and context on the chart, published by an agent with no trading authority | I get advisory context without handing anything control |
| UC-6 | Trader | review MES, MCL and MGC one at a time, each with its own active contract and session | each market is read on its own terms |
| UC-7 | Trader | read EMAs, VWAP, RSI, MACD and ATR on the same axes as the liquidity view | trend, momentum and volatility sit beside liquidity |
| UC-8 | Trader | save a layout and have it restored | I don't rebuild my settings each session |
| UC-13 | Trader | read spread, microprice, depth and imbalance, liquidity added/pulled/filled, delta, trade rate and walls as numbers with fixed definitions | I can quantify what the heatmap shows |
| UC-14 | Trader | read footprint volume, diagonal imbalances, per-bar delta, session CVD and the signals derived from them, each switchable | I see where aggression wins, stalls or gets trapped |
| UC-15 | Trader | see whether resting liquidity is real: icebergs, size pulled on approach, and sweeps that fail back | I know which liquidity to trust |
| UC-16 | Trader | see where the session built and skipped value: POC, value area, high- and low-volume nodes, a TPO profile | I can read the structure behind price |
| UC-17 | Trader | run on a deterministic simulated market or a recorded replay with no credentials, always labelled | I can learn, demo and test without live data |
| UC-18 | Trader | scan every product on one page and open any one in detail, with depth for the few I star | I pick a market without paying for depth on all of them |
| UC-19 | Trader | see whether each product is trending or ranging on 5- and 15-minute bars, by a stated rule, and where it has been ranging, as shaded range zones (FR-75) | I know what kind of market I am reading |
| UC-20 | Trader (`view-dashboard`, `configure-layout`, `request-feedback`) | define a simulated entry with a protective stop and up to three targets on a product, see it tracked against the live feed, and ask for feedback on fill likelihood and placement | I can rehearse a trade plan against real liquidity without placing an order |

UC-9–UC-12 are reserved (longer profile windows, further instruments) and not specified.

## 4. Requirements

Prices are integer ticks of the contract unless a requirement says otherwise. Every order-flow threshold is
configurable under `Engine:OrderFlow:<name>` ([`DEPLOYMENT.md`](DEPLOYMENT.md) §3), and each order-flow pane or
signal can be switched on or off in the layout (FR-9).

### Chart, time and data integrity

| ID | Requirement | Serves | Status |
|---|---|---|---|
| FR-1 | **Shared slice grid.** Heatmap and bars use one display interval (1, 2, 5 or 15 minutes, default 1) with identical half-open bins. The engine integrates the book on one-second slices and folds them into one-minute columns; the client re-aggregates both onto the chosen interval, so candle and cell boundaries match. | UC-1 | Built |
| FR-2 | **Independent settings.** Display interval, visible history (30 minutes to 3 days, default 4 hours), each indicator's period and source timeframe (1, 5 or 15 minutes), VWAP anchor, profile window, footprint length and render cadence are independent. One-second slices are kept 60 minutes; minute bars and heat columns 3 days. Changing the interval or history leaves profiles and closed indicator values unchanged. | UC-2 | Built |
| FR-3 | **Common price axis.** The volume profile sits left of the chart, heat cells behind matching prices, and indicators, markers and agent levels on the same axis; they stay aligned through zoom and pan. | UC-1 | Built |
| FR-4 | **Status is always visible.** One status per instrument: LIVE, REPLAY or SIMULATED while healthy (its provenance, D-14); DEGRADED while dropped trades are not yet cleared (D-32, D-33); STALE or RECOVERING otherwise. It shows last-event age, covered depth, recent coverage and when any profile or VWAP became partial. DEGRADED holds until a fresh post-subscribe book or the next session; repaired minutes stay flagged until they roll off, and CVD stays unknown meanwhile. Replayed or simulated data, and a feed that dropped a trade, never report LIVE. | UC-4 | Built |
| FR-5 | **Contract-keyed data.** Every record is keyed by contract, tick size and expiry, and the active contract is shown. A roll starts a separate book, profile and indicator history; nothing is back-adjusted. An event for another contract, off the tick grid, or stamped more than 60 s after it was received is refused and counted ([`INTERFACES.md`](INTERFACES.md) A.5). Roll policy is open (D-5). | UC-6 | Built |
| FR-6 | **Read-only product.** No trading action, execution tool or order endpoint exists in any permission path, the agent's included, and no metric or signal triggers one. A simulated position (FR-72) is a chart annotation that never leaves the dashboard as an order: no route, hub method or permission sends or forwards it to a broker. Inspection of payloads, routes, hub methods and permissions finds no order capability. | UC-1–UC-8, UC-13–UC-17, UC-20 | Built |
| FR-7 | **Raw values on hover.** Hover shows the untransformed time-weighted quantity and coverage for bid and ask, whatever colour scale is in use. | UC-3 | Built |
| FR-8 | **Versioned agent overlay.** An overlay carries instrument, contract, version, generated/as-of/expiry times (UTC), source coverage, levels and a plain-text rationale. The newest valid version applies, expired levels are marked, and nothing is drawn before its availability time. Stale, expired, future-dated or wrong-contract overlays are refused with a reason, and overlay failure never touches ingestion or market data. | UC-5 | Built |
| FR-9 | **Saved layout.** Validated settings (instrument, interval, history, heat contrast, event-dot size, the price-center lock, the panes shown, the indicator dock's tab and whether it is collapsed (one dock, the same on Detail and Order Flow), Detail's main chart (`detailChart`: `footprint`, the default, or `price`), which side-column sections are folded, the simulated positions the viewer has drawn (`positions`, by product root, FR-72) and which signals are shown, and the range-zone bars `rangeZoneTimeframe`: `300`, the default, `900` or `off`) round-trip and restore independently of the stream. An unknown pane, signal or section key is refused, never ignored, and an invalid position is refused naming the field. A save that omits `positions` keeps the stored ones. A save whose revision is not the stored counter is refused and the stored layout kept. No credential is stored in browser storage. | UC-8, UC-14, UC-15 | Built |
| FR-10 | **Every product, one in detail at a time.** The products of `Engine:Instruments` (default `*`, less `Engine:ExcludeInstruments`) are collected concurrently from start. MES, MCL and MGC are the default watchlist; one menu switches, adds and removes favorites. Switching products shows that product's continuous state without restarting its collection. | UC-6, UC-18 | Built |
| FR-11 | **Unknown is not zero.** Prices outside the subscribed depth, and every price during an outage, reset or ordering ambiguity, are unknown until a fresh baseline arrives; nothing is filled forward. | UC-3, UC-4 | Built |
| FR-12 | **Heatmap value.** Each cell is the time-weighted mean quantity over the *known* milliseconds of its bin, with known and total duration kept apart; resampling combines integrals, never means of means. 10 contracts for 0.8 s and 20 for 0.2 s gives 12. A half-known slice is shown as partial. | UC-1, UC-3 | Built |
| FR-13 | **Trade-derived bars.** OHLC comes from executed trades only, never quote midpoints; a bin with no trade stays explicitly empty. | UC-1 | Built |
| FR-14 | **Volume conservation.** Executions are de-duplicated; depth updates never change executed volume. A profile's total equals the accepted volume over its window. | UC-1 | Built |
| FR-15 | **Time and sessions.** Instants are stored in UTC and shown in America/Chicago. Sessions follow each exchange's calendar, including the daily break and DST. Holidays and early closes are not modelled yet. | UC-4, UC-6 | Partial |

### Indicators and profiles

| ID | Requirement | Serves | Status |
|---|---|---|---|
| FR-16 | **Indicator set.** EMA 10, 13, 24, 48 and 200, session VWAP, RSI, MACD and ATR, each with its own parameters and source timeframe (default one minute, D-13). Changing one changes only that one. | UC-7 | Built |
| FR-17 | **Closed and developing values.** Indicators use complete source bars; a closed value appears only when its bar completes. An optional developing value is marked and never alters closed history. Values are hidden until warmup completes. EMA uses alpha = 2/(N+1), seeded by the SMA of the first N closes. | UC-4, UC-7 | Built |
| FR-18 | **VWAP.** Σ(price × quantity) / Σ quantity since the anchor (default the current session), with ±1σ and ±2σ bands. Missing trade coverage marks it partial. | UC-7, UC-4 | Built |
| FR-19 | **RSI.** Wilder's RSI, period 14, in a lower pane on 0–100. | UC-7 | Built |
| FR-20 | **MACD.** EMA(12) − EMA(26), signal EMA(9), histogram, in a lower pane. | UC-7 | Built |
| FR-21 | **ATR.** Wilder's ATR of true range, period 14, in price units and ticks. | UC-7 | Built |
| FR-22 | **Panes.** EMAs, VWAP and agent levels overlay the price chart. Volume, CVD, RSI, MACD, ATR and TPO share one indicator dock under the chart, on Detail and on Order Flow alike, that shows one tab (`indicatorPane`, default `volume`) and collapses to its tab strip (`indicatorDockCollapsed`, D-39); the tab and the collapse are the same on both tabs (D-56). Volume draws each chart bar's traded volume, split into sell, buy and any unsided rest, with warmup bars in the warmup grey and no side. The footprint is Detail's main chart by default; a Footprint / Price switch brings back the price chart, saved as `detailChart` (D-55). Each section of the side column folds to its heading from a keyboard-operable button, saved as `sideSectionsCollapsed` (D-49). | UC-7 | Built |
| FR-23 | **Volume profile window.** Executed quantity per tick over the session, rolling 1 h, 4 h and 5 days, independent of the viewport; the chart draws the 5-day profile on its left edge with POC, VAH and VAL. | UC-2 | Built |
| FR-24 | **POC and value area.** POC is the highest-volume price (ties to the lower). The value area grows from the POC, adding the higher-volume neighbour (lower on ties), until it holds at least 70% of the volume. | UC-2 | Built |
| FR-25 | **Partial profiles.** A profile started mid-session reads "partial since …" until the gap is backfilled. Backfill reconciliation is not built. | UC-4 | Partial |
| FR-26 | **Readout and scaling.** The cursor readout shows time with offset, contract, OHLC, volume, bid and ask quantity, coverage and indicator source times. Bid and ask use separate hues with a labelled scale; adaptive scaling is labelled and never silently rescales history. | UC-3 | Partial |

FR-27–FR-35 are reserved and not specified.

### Liquidity metrics

| ID | Requirement | Serves | Status |
|---|---|---|---|
| FR-36 | **Top of book.** Best bid and ask with sizes; spread in ticks; microprice = (bid × ask size + ask × bid size) / (bid size + ask size). Null while the book is unknown or a side is empty, never zero. Bid 100 × 30 against ask 101 × 10 gives spread 1 and microprice 100.75. | UC-13 | Built |
| FR-37 | **Depth and imbalance at 1, 5 and 10 levels.** Summed size of the N best non-empty levels per side; imbalance = (bid − ask) / (bid + ask), null when both are zero. | UC-13 | Built |
| FR-38 | **Added, pulled, filled.** A size increase is *added*; a decrease is *filled* up to the volume traded there against that side in the previous 2 s, and the rest is *pulled*. Totals over 10 s and 60 s. A baseline snapshot never counts as added. | UC-13, UC-1 | Built |
| FR-39 | **Delta, trade rate and session volume.** Cumulative delta since the session anchor, 60-second delta, trade rate (contracts per second over 10 s) and session volume. A new session resets the cumulative values. | UC-13 | Built |
| FR-40 | **Persistent walls.** A covered level at least 3 × the median covered size (at least four levels needed) is a wall; the three largest per side are reported with their age. | UC-13 | Built |

### Order flow

| ID | Requirement | Serves | Status |
|---|---|---|---|
| FR-41 | **Footprint bars.** Per bar (default 60 s, `FootprintSeconds`), bid and ask volume at every tick, OHLC, volume, delta and its running extremes, and each cell's diagonal-imbalance flag. The last 60 closed bars and the developing bar are sent. On Detail it is the main chart, one row per price tick on the price chart's price window, so it pans, zooms, fits, centres and locks as the price chart does; each bar's delta sits in a row under the plot (D-55). | UC-14 | Built |
| FR-42 | **Stacked imbalances as zones.** Buying at P is imbalanced when ask volume at P ≥ 3 × bid volume at P − 1 and ≥ 4 contracts (selling mirrors it). Three or more consecutive same-direction ticks in a closed bar form a demand or supply zone, active until traded through; at most 20. Signal `StackedImbalance`. | UC-14 | Built |
| FR-43 | **Unfinished auctions.** A closed bar's high or low where both sides traded stays marked until a print trades beyond it; at most 20. Signal `UnfinishedAuction`. | UC-14 | Built |
| FR-44 | **Trapped traders.** A delta spike (z-score ≥ ±2 against up to 20 earlier bars, at least 8) within 4 ticks of a key level traps its side when a bar within the next 2 closes beyond the spike bar's far extreme. Signal `TrappedTraders`. | UC-14 | Built |
| FR-45 | **Per-bar delta and session CVD.** Every footprint bar shows its delta; session CVD sums closed-bar deltas since the session start, drawn on the indicator dock's CVD tab on Detail and Order Flow alike: the warmup stretch in the warmup grey, the live stretch in `up` while the session CVD is positive and `down` while it is negative, on a scale fitted to the CVD in view, with a zero guide only when zero is in range (D-56). Warmup bars carry no aggressor, so CVD counts from live collection. | UC-14 | Built |
| FR-46 | **CVD divergence.** Swing highs and lows (3 bars each side) are compared on CVD within 90 bars: a higher high on lower CVD is bearish, a lower low on higher CVD bullish. Signal `CvdDivergence`. | UC-14 | Built |
| FR-47 | **Delta exhaustion.** A delta spike near a key level on a bar at least 2 ticks tall that closes in the weak 40% of its range. Signal `DeltaExhaustion`. | UC-14 | Built |
| FR-48 | **Pulled liquidity.** A level at least max(2, 3 × median) that rested ≥ 2 s and lost ≥ 60% of its peak to pulls (≤ 15% traded) as the market came within 4 ticks is reported. Live depth only. It describes size withdrawn on approach, never anyone's intent. Signal `Spoof`. | UC-15 | Built |
| FR-49 | **Sweeps.** Watched levels are the prior session's high and low and confirmed swing pivots (at most 24). A print ≥ 1 tick beyond that comes back inside within 120 s is a sweep; otherwise the level retires as a breakout. Signal `LiquiditySweep`. | UC-15 | Built |
| FR-50 | **Profile nodes.** Each profile reports POC, VAH, VAL and its high- and low-volume nodes, found on a smoothed profile (HVN ≥ 1.5 × mean, LVN ≤ 0.5 × mean, local over ±3 ticks, at most 5 each). | UC-16 | Built |
| FR-51 | **TPO profile with single prints.** Each 30-minute period gets a letter; the row with most letters is the TPO POC; runs of at least 2 rows touched by one period only are single prints, reported once when the period ends. Signal `SinglePrints`. | UC-16 | Built |
| FR-52 | **Icebergs.** A resting price that refills within 1,500 ms of prints at least twice, trades at least 1.25 × the most it showed, and reaches confidence ≥ 0.35 is an iceberg; the hidden size is a lower bound. Live depth only. Signal `Iceberg`. | UC-15 | Built |
| FR-53 | **Simulated and replayed markets.** `Feed:Provider` `Synthetic` runs one deterministic, seeded simulator per instrument that stages the situations FR-41–FR-52 look for (D-12, D-25); `Replay` plays a JSON Lines file of normalized events. Neither needs a credential, and neither ever reports LIVE. The same seed gives the same events. | UC-17, UC-4 | Built |

### Every product, the Overview and the regime

| ID | Requirement | Serves | Status |
|---|---|---|---|
| FR-54 | **Every product, depth only where watched.** Trades, and quotes where the feed has them, for every enabled product; depth only for `Feed:Depth:Pinned` (MES, MCL, MGC) and the products a connected viewer has open or starred, up to `Feed:Depth:MaxSubscriptions` (8), kept 30 s after the last viewer leaves. A product without depth shows its quote-based top of book and its book as unknown on purpose. Only subscribed products build deltas. | UC-18, UC-6 | Built |
| FR-55 | **Product picker and watchlist.** `GET /api/instruments` lists every enabled product with its status and a cheap summary. The layout keeps a watchlist (`Api:MaxWatchlist`, 12) that gets depth while the viewer is connected; the server says which got depth and which were refused. | UC-18 | Built |
| FR-56 | **Trend regime.** On 5- and 15-minute trade bars: Trending when ADX(14) ≥ 25 and the 20-bar efficiency ratio ≥ 0.30, up or down when DI and EMA 13/48 agree; Ranging when ADX ≤ 20 and the ratio ≤ 0.20; Transition otherwise; Unknown for the first 28 bars. Every input is configurable and each reading reports its inputs. Warmup loads 7 hours so the slowest timeframe is ready. The same classifier's Ranging stretches are FR-75's range zones. | UC-19 | Built |
| FR-57 | **Overview tab.** One sortable, filterable row per product (status, last, change, range, volume, delta, trade rate, latest signal, both regimes and whether they agree), refreshed every 2 s; a row opens that product in detail; a star adds it to the watchlist. The Overview draws no chart and adds no depth subscription of its own. | UC-18, UC-19 | Built |

### The chart and the Order Flow tab

| ID | Requirement | Serves | Status |
|---|---|---|---|
| FR-58 | **Heatmap ramp.** A full-bleed Canvas 2D heatmap (black → blue → yellow → orange → red in the dark theme; in Light the ramp rises from the chart ground, the warm paper `#efede7`, so an empty price is that ground, D-50), with dimming, percentile cutoffs and auto-contrast applied at draw time only. | UC-1 | Built |
| FR-59 | **Volume dots.** The default price mark: live prints per pixel-time slice at the slice VWAP, log-scaled radius, buy aggressor in the `up` colour and sell in `down` (D-48), with a minimum-size filter. On every tab each dot's edge is outlined by side, green for the buy share and red for the sell share, outside a thin halo (D-52). Candles are an optional toggle that changes no indicator or profile. | UC-1 | Built |
| FR-60 | **Best bid, best ask and the last-trade flash.** Thin best-bid and best-ask lines and a fading flash of the last print. The lines hide, and the chart says so, when the quote is missing or stale. | UC-1 | Built |
| FR-61 | **No aggressor dots on warmup history.** Warmup bars have no aggressor, so dots are drawn only from live prints after `historyWatermarkMs`; the earlier region is labelled history. | UC-1 | Built |
| FR-62 | **Inferred signals say so.** Iceberg, sweep, spoof and trapped-trader markers say they are inferred from prints and book changes; the intent-inferring ones are drawn hollow. None is named a confirmed stop run or an exchange order-level flag. | UC-15 | Built |
| FR-63 | **Named session levels.** Prior-day RTH high and low, Asia high and low, the daily open, the 4-hour mid, and the prior week's high and mid, each with a label, session and as-of time, on exchange-local wall times (D-35). A window the bars do not cover is omitted. | UC-1 | Built |
| FR-64 | **Layout preset.** "Nodes (HVN/LVN)" emphasises node shelves and targets; "Value area (POC/VAH/VAL)" shows the value area. Stored as `rips` and `standard`; neither recomputes anything. | UC-16 | Built |
| FR-65 | **Failed-reclaim marker.** On Order Flow, a named extreme that live prints trade at least a tick beyond and re-enter within 120 s is marked at the return. Inferred from prints; not a stop-run claim; places nothing. | UC-1 | Built |
| FR-66 | **Read-only trailing-stop guide.** After a failed reclaim, a guide from the broken midpoint to the nearest LVN on the return side (else the POC, else the next named level). It says it is read-only and calls no broker. | UC-1 | Built |
| FR-67 | **Order Flow tab.** A third view (`?tab=orderflow`; `?tab=bookmap` also opens it) of the same stream: heatmap and volume dots, PRICE, COB and SVP docked on one price scale, the indicator dock Detail shows (Volume, CVD, RSI, MACD, ATR and TPO) under the chart on the chart's time window, colour-coded event dots with a key, a Display menu, the Price group (+, −, Fit, Center and Lock, shared with Detail, D-54), and pointer, wheel and pinch zoom on both axes. A price zoom or a vertical drag reaches every fitted price at any zoom and never leaves the plot blank (D-38). An Alt-click on the plot places a simulated position (FR-72, D-58). The wheel zooms only while the whole plot is in view; while a scrollable page cuts it off, the wheel scrolls the page (D-53). Unknown depth is said, never painted as zero. No order control. | UC-1, UC-16 | Built |
| FR-68 | **Detail pan and anchored zoom.** On Detail, drag pans time and price, the wheel zooms time about the pointer, a pinch zooms both axes, and double-click restores the fit. Detail and Order Flow share the same time window. The wheel follows the same gate as Order Flow (D-53). A Price group above the chart carries the same +, −, Fit, Center and Lock as Order Flow, from the same component; Lock is one setting for both tabs (`centerPrice`), released by any price zoom or a vertical drag of 4 px or more (D-54). The footprint main chart takes all of this the same way (D-55), and on Detail's price and footprint charts a vertical drag reaches every fitted price by the same bound as Order Flow (FR-67). | UC-1 | Built |
| FR-69 | **Event history and last-price line.** Every enabled event inside the visible window is drawn (up to 20,000 per instrument kept), and a snapshot backfills signals for the loaded history. A last-traded-price line crosses the window, breaking only at a feed hole or the session open. | UC-1 | Built |
| FR-70 | **Terminal and Light themes.** A dark theme (Terminal, default) and a Light theme; with no stored choice the page follows the operating system. The choice is kept in this browser only, applies at once, and every canvas redraws in the new colours. Light's ground is a subdued warm paper (`#efede7`) rather than white (D-50). Both themes' defaults meet the NFR-8 contrast floors; a viewer may also choose each chart colour per theme (FR-71). | UC-1 | Built |
| FR-71 | **User chart colours.** A **Chart colours** button in the top bar, on every tab, opens a panel for the active theme listing each chart colour role (up and down, the volume-dot outlines, bid and ask, the heat-ramp stops, the price lines, VWAP, EMAs and indicator lines, the levels, the signal biases, each Order Flow event marker, and warmup) with a picker, a sample, its worst contrast, a warning below its NFR-8 floor that never blocks the choice, and a reset; **Reset all** at the bottom. Surfaces, text and chrome are not offered. A chosen colour is used wherever its role is drawn, on every tab, and what derives from it follows. Choices are kept per theme in this browser only, in `localStorage` under `futures-liquidity-dashboard.chart-colors.v1`, never with the layout or on the server; an unknown role or a value that is not a six-digit hex colour falls back to the theme default. A change redraws every canvas with no reload (D-51). | UC-1, UC-14, UC-16 | Built |
| FR-75 | **Range zones.** The server marks where a product was ranging by FR-56's own classifier, never a copy: each regime timeframe merges its consecutive closed bars classified Ranging into zones `{startMs, endMs, lowTicks, highTicks}`, from the first bar's open to the last bar's close and from the lowest to the highest trade in those bars. A bar of any other class, or with no trades, ends a zone; bars before FR-56's warmup are never shaded; the developing bar is never in a zone. The snapshot carries every timeframe's zones and a delta repeats them only when they changed; a zone is dropped once it ended before the retained minute bars (FR-2). The layout saves which timeframe is drawn (`rangeZoneTimeframe`, FR-9: `300`, the default, `900` or `off`; 15-minute zones cannot form until hours after a restart, which is why 5 minutes is the default) and the Layers toggle "Range zones" (the `range-zones` pane, on by default). Detail's price and footprint charts and Order Flow draw that timeframe's zones the same way: a neutral box at low opacity with hairline top and bottom edges, no label, behind the price marks. It does not change the price fit. On Order Flow only the edges are drawn inside the warmup band, to keep NFR-8's contrast. The client never classifies a regime (D-62). | UC-19 | Built |

### The simulated position and its feedback

| ID | Requirement | Serves | Status |
|---|---|---|---|
| FR-72 | **Simulated position.** One per product root, saved with the layout (FR-9, D-57): `side` (`long` or `short`), `entryType` (`limit` or `market`), `entryTicks` (required for a limit), `quantity` (1 to 100), `stopTicks`, up to three `targets` of `{ priceTicks, quantity }` whose quantities sum to no more than the position's, and the contract. For a long the stop sits below the entry and every target above it, and a short is the mirror image; every price is a whole number of ticks within 1,000,000,000 of zero; an invalid position is refused naming the field. A position for a contract that is no longer the root's active one is dropped on read. **Placing and editing (D-58).** Alt-click on the plot of Detail's price or footprint chart, or of Order Flow, places a limit entry at the clicked tick with a stop and one target; a plain click or drag still pans. The entry, stop and targets are horizontal lines you can drag on the tick grid, and a ticket above each chart edits the same values from the keyboard; a change that breaks a rule springs back and says which. Every line and the ticket are labelled **SIMULATED**. **Tracking (D-59).** The browser tracks the position against the live prints it already receives and saves the result with the layout. A limit entry fills only on a print strictly through its price, a market entry on the next print, the stop on the first print at or through it, and a target on a print strictly through it, with scale-out and profit and loss in ticks, currency and R (the entry-to-stop distance, fixed at the fill). Warmup prints and prints while the feed is not healthy fill nothing, and the ticket says where tracking was missed. Commissions, slippage and queue position are not modelled, and nothing is tracked on the server. It is an annotation, never an order (FR-6). | UC-20 | Partial |
| FR-73 | **Plan metrics.** `POST /api/plans/metrics/{instrument}` takes an FR-72 position and returns named, versioned metrics (`definitionsVersion` 1) computed on the server from one consistent reading of the engine; it stores nothing (D-60). A value the inputs cannot support is null with a reason, never zero (FR-11). Per leg (entry, stop, each target): distance from the last price in ticks and in ATR; for the entry and targets, the resting size ahead now and its time-weighted mean over the last 10 minutes with its coverage; how often the last 60 and 240 one-minute bars traded strictly through the price; when the price was last reached; and what lies in the way (walls, icebergs, spoof and sweep signals) and which key levels and order-flow signals lie within 2 ATR. For the plan: reward to risk per target, the stop's distance in ATR, whether the stop sits just inside a key level or wall, and, for a market entry, how far its size walks past the touch. It also reports the two regimes (UC-19) and the coverage. The metrics describe; they predict no fill and trigger nothing (FR-6, P1). | UC-20 | Built |
| FR-74 | **Position feedback.** `POST /api/plans/feedback/{instrument}` takes an FR-72 position, computes its FR-73 metrics and returns `{ metrics, feedback, reason, provider, model }` (D-61). It runs only on request: nothing is stored and nothing runs on a timer. `Feedback:Provider` is `Claude`, which sends the position's metrics to the Claude Messages API with a fixed system prompt and the data in the user message, or `Mock`, which writes deterministic feedback from the metrics alone, needs no key and costs nothing. Development and compose default to `Mock`; production ships `Claude` with `Feedback:Enabled` false, so the feature stays hidden until it is enabled and a key is set. The feedback is a summary, a fill likelihood (`low`, `medium`, `high`, `unknown`) and assessment per leg, an optional suggested price, and risks, and **every claim cites the metric names it rests on**: the server validates the reply again and drops any claim that cites nothing real, and reports how many it dropped. A refusal, a timeout, a rate limit, an upstream error or a reply that fails the schema returns the metrics with `feedback: null` and a reason. `GET /api/plans/feedback/status` returns whether feedback is available and the month's spend against its cap, never the key. A request needs `request-feedback` and `view-dashboard` on the instrument; a viewer may have one request in flight and start six a minute. The monthly cap (`Feedback:MonthlyBudgetUsd`, default $100) is counted in memory from each reply's token use, so a restart resets it. Only derived metrics are sent, never raw depth or trades. The feedback is advisory, mechanical context, not financial advice, and never an instruction to place an order (FR-6). **The panel.** The ticket's Feedback button and the panel stay hidden unless the server says feedback is available (a spent budget keeps the button and shows the over-budget state). One press sends one request, never retried. The panel sits beside the chart (under it on a narrow window): the as-of time, the summary, each leg with its fill likelihood as text, its assessment, its suggestion and the metrics it cites, then the risks. A footer that stays in view says "Advisory: model commentary on mechanical metrics. Not financial advice. Simulated position; nothing is sent to a broker.", plus a **MOCK** label whenever the provider is `mock`. Each suggestion is also a dashed ghost line on the chart that one click applies through the same edit rules. Feedback goes stale once the position changes or the last price moves more than 1 ATR from its as-of price, and it never refreshes itself. The panel is reachable from the keyboard (NFR-8). | UC-20 | Built |

### Non-functional

| ID | Requirement | Serves | Status |
|---|---|---|---|
| NFR-1 | **Freshness.** p95 server receive → browser apply ≤ 500 ms; STALE after 3 s with no feed activity during an open session. | UC-4 | Partial |
| NFR-2 | **Rendering.** p95 frame time ≤ 33 ms for one instrument with a 60-minute viewport and the indicator dock, on declared hardware. | UC-1 | Partial |
| NFR-3 | **Recovery.** A fresh coherent baseline within 10 s of the transport returning, where the upstream allows snapshots; RECOVERING until then. | UC-4 | Partial |
| NFR-4 | **Bounded resources.** No unbounded growth over a 24-hour soak with every enabled product; memory capped by instruments, depth, retained duration and queue limits; pressure leads to controlled recovery or declared loss, never silent dropping. | UC-1–UC-7 | Partial |
| NFR-5 | **Data integrity.** No silent sequence gaps or unmarked coverage losses; duplicates never apply twice; a browser sequence gap triggers a resync. | UC-3, UC-4 | Built |
| NFR-6 | **Security.** Broker credentials stay server-side and never appear in payloads, URLs, browser storage, logs or agent context; viewers authenticate; transport is encrypted; a credential with broader powers is used only behind a strictly read-only set of calls. The Claude API key is a server-side credential too: read only from `Feedback__ApiKey` or `ANTHROPIC_API_KEY`, sent only to the Messages API, and never in a payload, URL, log line, trace, metric label or error body (T-10). See the threat model in [`ARCHITECTURE.md`](ARCHITECTURE.md). | UC-1–UC-8, UC-20 | Partial |
| NFR-7 | **Licensing.** Before collecting or hosting live data, document the rights for personal use, storage, derived displays and non-display processing of the exchanges' depth and trade data; assume no redistribution rights. The maintainer has confirmed that their data terms allow agent (non-display) processing of the derived metrics sent for FR-74, not raw depth or trades; personal use, storage and derived displays are not yet documented here. | UC-1–UC-7, UC-20 | Partial |
| NFR-8 | **Accessibility.** Keyboard-accessible controls, non-colour coverage markers and a text readout. In both themes, the token contrast test (`src/dashboard/src/design/contrast.test.ts`, WCAG 2.2 SC 1.4.3 and 1.4.11) holds every listed text token at 4.5:1 on each surface, every listed line and meaningful border at 3:1, text on its own fill at 4.5:1, and a split footprint cell's text at 4.5:1 on every `up` and `down` shade. The volume-dot outlines hold 3:1 on the darkest heat stop; on each brighter stop the outline or its halo holds 3:1, and the outline holds 3:1 on its halo; each outline stays visibly distinct from bid, ask, up, down, the other outline and every event marker (D-52). The `range-zone` line token (a range zone's hairline edge, FR-75) holds 3:1, and every text and line token holds its floor on the zone's fill. Every listed token also holds its floor on the Order Flow warmup band (`warmup` at 0.25 alpha over the plot's ground), so the warmup candles, price step, watermark edge and caption stay readable. There is no exception. These floors bind the theme defaults; a viewer's own chart colour (FR-71) may fall below one, with a warning, and the choice stands (D-51). | UC-3 | Partial |
| NFR-9 | **Cost.** An approved monthly budget and cost alerts exist before any hosted deployment. FR-74's Claude spend has a cap, `Feedback:MonthlyBudgetUsd` ($100 a month), enforced by the API and exported as `fld_feedback_spend_usd`. The count is in memory and a restart resets it, so it is a guard, not a bill: the Anthropic console's usage is the record. No cost alert exists yet. | UC-1–UC-7, UC-20 | Proposed |

## 5. Out of scope

- Order entry, modification, automatic execution or practice-account trading, ever, including from a metric, a
  signal, an overlay, a simulated position or its feedback (FR-6, P1).
- A strategy or backtest engine, or any claim that liquidity or a signal predicts movement (P1).
- Naming or accusing a participant: a pulled-liquidity signal reports size withdrawn, nothing about intent (FR-48).
- An exact hidden size: an iceberg reading is a lower bound with a confidence (FR-52).
- Depth-based detectors on history: depth is never backfilled, so they run on live data only (FR-48, FR-52, FR-11).
- Multi-user use or redistribution of market data (NFR-7).
- Committing recorded market data to the repository: replay files are supplied at run time and fixtures are
  synthetic (FR-53, NFR-7).
- More than one instrument in detail at a time (FR-10, P4); the Overview's rows are not a detailed view (FR-57).
- Treating a regime as a forecast (FR-56, P1).
- Unlimited history or historical depth backfill (FR-11, NFR-4), and full order-by-order book reconstruction (FR-12).
- Continuous or back-adjusted contracts for live depth (FR-5).
