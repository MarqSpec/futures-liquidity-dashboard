# Observability

What the API exposes for monitoring: health checks, readiness and Prometheus metrics. Section numbers (`§2`, `§3`)
are cited from the code.

## 1. Scraping

The API serves `/metrics` in Prometheus format. Point any Prometheus at it every 15 s or so. Outside Development,
`/metrics`, `/health/ready` and `/api/diagnostics/depth-width` require an authenticated caller (D-30): the scraper sends `X-Api-Key` with a key that
holds any grant, or the API sets `Auth__ProtectDiagnostics=false` when the scraper cannot and the port is not
public. `/health/live` never requires a key. Compose runs the API in Development, so a local scrape needs no key.
These endpoints expose instrument status and counters, never prices, orders or personal data.

## 2. What the API exposes

The API is instrumented with OpenTelemetry and the Prometheus exporter (`GET /metrics`). ASP.NET Core's
instrumentation provides `http_server_request_duration_seconds` (a histogram: request rate, error ratio and
latency).

Its own instruments are on the meter `MarqSpec.FuturesLiquidityDashboard`. Prometheus names replace the dots with
underscores and append the unit to a gauge that declares one. The feed gauges have one label, `instrument` (a root
being streamed), and are read at scrape time from each engine's status, so they cost nothing between scrapes. The
ingest and publish instruments use a fixed `lane` or `kind` label, never a contract id (D-32).

| Metric | Type | Meaning |
|---|---|---|
| `fld_feed_event_age_milliseconds{instrument}` | gauge | Milliseconds since the instrument's last event; −1 before the first |
| `fld_feed_connected{instrument}` | gauge | 1 while the upstream session is connected |
| `fld_book_known{instrument}` | gauge | 1 while the order book is known |
| `fld_feed_rejected_events{instrument}` | gauge | Events refused since start: another contract, a price off the tick grid, or a source time more than 60 s after receipt ([`INTERFACES.md`](INTERFACES.md) A.5) |
| `fld_feed_clock_ahead_rejected_events{instrument}` | gauge | The part of the above refused for the clock; a rise on every instrument at once points at the host clock |
| `fld_ingest_queue_depth{lane}` | gauge | Events waiting in the ingest buffer; `lane` is `trade`, `quote`, `depth` or `control` |
| `fld_ingest_coalesced_total{lane}` | counter | Quotes, depth rows or connection updates replaced by a newer one |
| `fld_ingest_trades_dropped_total` | counter | Trades that did not fit in their contract's queue; the contract turns DEGRADED (D-32, D-33) |
| `fld_orderflow_late_signals_dropped_total` | counter | Order-flow signals not stored because they were behind the newest one kept (D-41) |
| `fld_ingest_depth_discarded_total` | counter | Pending depth rows thrown away on a price-cap overflow or a disconnect |
| `fld_ingest_recoveries_total{kind}` | counter | Contracts sent to the snapshot or history path; `kind` is `depth` or `trades` |
| `fld_publish_in_flight` | gauge | Delta sends currently waiting on a browser |
| `fld_publish_skipped_total` | counter | Deltas not delivered because that browser was still taking the previous send |
| `fld_publish_aborted_total` | counter | Browser connections aborted after `Api:PublishTimeoutMs` |
| `fld_depth_levels_per_side` | gauge | The configured `Feed:ProjectX:LevelsPerSide` (default 50, allowed 5–200). Not a received count |
| `fld_depth_ladder_levels` | gauge | The configured `Engine:LadderLevels` (default 40, allowed 5–200) |
| `fld_depth_received_bids_max{instrument}`, `fld_depth_received_asks_max{instrument}` | gauge | The most distinct bid (ask) prices with size the market hub has sent since the process started, before the `LevelsPerSide` trim |
| `fld_depth_received_bids_typical{instrument}`, `fld_depth_received_asks_typical{instrument}` | gauge | The lower median of distinct bid (ask) prices, one sample a second, over the last 256 samples |
| `fld_depth_received_bids{instrument}`, `fld_depth_received_asks{instrument}` | gauge | Distinct bid (ask) prices in the untrimmed book now |
| `fld_depth_received_capped{instrument}` | gauge | 1 once a side hit the 256-price store, so the maximum is a lower bound |
| `fld_feedback_requests_total{provider,outcome}` | counter | Position feedback requests (FR-74). `provider` is `claude` or `mock`; `outcome` is `ok`, `refusal`, `timeout`, `error`, `invalid-response`, `over-budget`, `throttled` or `unavailable` |
| `fld_feedback_duration_milliseconds{provider,outcome}` | histogram | How long a model call took, for the requests that made one |
| `fld_feedback_tokens_total{kind}` | counter | Tokens the Claude calls used; `kind` is `input`, `output`, `cache-write` or `cache-read`. The mock counts none |
| `fld_feedback_spend_usd`, `fld_feedback_budget_usd` | gauge | This UTC month's Claude spend in US dollars, counted from usage and kept in `Feedback:BudgetStorePath`, so it resumes after a restart in the same month and starts at zero in a new one; and `Feedback:MonthlyBudgetUsd` (NFR-9) |

Labels stay bounded: `instrument`, `lane`, `kind`, `provider`, `outcome`, never contract ids, key names, prompts, replies or raw paths.

## 3. Feed health and readiness

`GET /health/live` answers 200 while the process runs, with no key. `GET /health/ready` reports the market data,
not just the process (NFR-3), and outside Development requires a caller unless `Auth:ProtectDiagnostics` is false:

- **Unhealthy (503)** until ingestion has loaded its history window and started streaming, and after a stream
  failure until it streams again. The description is fixed ("Ingestion is starting." or "The market-data feed
  failed and is restarting; see the API logs."), never the upstream error, which goes to the log. When the login is
  refused or a feed setting is wrong, ingestion stops instead (D-37) and readiness says the credentials or
  configuration were refused, with one Critical `FeedRefused` log line.
- **Degraded (200)** while any instrument is DEGRADED, STALE or RECOVERING; the description names them.
- **Healthy (200)** otherwise.

The body is JSON: `{status, checks: {ingestion: {status, description, data: {feed, provenance, restarts, <ROOT>:
<status code>, …}}}}`. The status code is the one the dashboard shows (FR-4, D-14, D-32): RECOVERING when not
connected or the book is unknown, else STALE when the last event is older than `Engine:StaleAfterMs` (3 s), else
DEGRADED while trades are missing or a repaired minute is still on the session profile, else the feed's
provenance. Readiness does not yet know whether the exchange is in session, so STALE during a scheduled break
degrades it.

For a deploy's smoke check use `/health/live` ([`DEPLOYMENT.md`](DEPLOYMENT.md) §3): readiness can be Degraded or
briefly Unhealthy while the feed recovers, which is not a failed deploy. A deeper probe of `/health/ready` sends
`X-Api-Key` as a header, never in the URL.

## 4. Alerts

No alert ships with the code. Useful starting points: the scrape target down, a high server error ratio on
`http_server_request_duration_seconds`, an instrument's `fld_feed_event_age_milliseconds` high during an open
session, `fld_book_known` at 0 for longer than a reconnect takes, `fld_ingest_queue_depth` near its cap, and any
increase in `fld_ingest_trades_dropped_total`.
