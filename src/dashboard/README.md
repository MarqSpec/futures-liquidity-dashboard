# dashboard

The browser UI of the Live Futures Liquidity Dashboard: a read-only view of resting liquidity beside executed price
for every futures product the API lists, with MES, MCL and MGC as the default tabs. React 19, Vite, TypeScript `strict`, canvas rendering, a SignalR client for `/hubs/market` and
zod validation of every inbound message. It never offers order entry.

## Run it

From the repository root, with the API listening on `http://localhost:5080` (`docker compose up --build`, or the
API project run locally):

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter dashboard dev        # http://localhost:5173
```

All requests are same-origin relative URLs, because the API sends no CORS headers:

- **Development:** the Vite proxy (`vite.config.ts`) forwards `/api`, `/health` and `/hubs` (WebSocket included)
  to `http://localhost:5080`.
- **Container:** nginx (`nginx.conf.template`) serves the build and forwards `/api`, `/health`, `/hubs`
  (with the WebSocket upgrade) and `/metrics` to `API_UPSTREAM`, which defaults to the compose service
  `futuresliquiditydashboard.api:8080`. A query string on those paths is proxied too. Set `API_UPSTREAM`
  where that name does not resolve. Other paths fall back to `index.html`. Same origin: no CORS header.

`VITE_API_BASE_URL` (`src/config.ts`) is optional and left empty by default. The delivered phone app is the PWA, which uses these same-origin URLs. A debug Android package does not use
that variable: on that shell the viewer types the server URL, and the browser build ignores that saved value
so this dev server stays same-origin. See [`DEPLOYMENT.md`](../../DEPLOYMENT.md).
There is no `VITE_*` API key: outside Development the page asks for the key and keeps it in `sessionStorage`
for that tab ([`ARCHITECTURE.md`](../../ARCHITECTURE.md) D-30). Development's
anonymous grants open the page with no prompt. The Android shell uses that same prompt.

## API key

The key is a password field. It is sent as `X-Api-Key` on `/api` and as the SignalR access token on
`/hubs/market`. A 401 replaces the dashboard with the prompt so the key can be entered again or cleared.
`sessionStorage` survives a reload and is dropped when the tab closes. `localStorage` is not used, because
the key would remain after the operator leaves a shared browser. A rejected stored key is dropped and the
page tries once with no key, so a leftover key does not block Development.

## Checks

The same commands CI runs from the repository root:

```sh
pnpm run lint     # oxlint --max-warnings 0 (.oxlintrc.json: react, typescript, oxc, jsx-a11y)
pnpm run test     # vitest run
pnpm run build    # tsc -b && vite build
pnpm audit --prod --audit-level low
```

After editing `src/design/tokens.json`, regenerate the stylesheet with `pnpm --filter dashboard run tokens`; a unit
test fails while `tokens.css` and `tokens.json` disagree.

Unit tests sit beside the code they cover (`src/**/*.test.ts[x]`) and use trimmed fixtures from the synthetic feed
in `src/test/fixtures/`.

## Layout

- `src/api/`: wire schemas (zod), the HTTP client and `MarketStream`, which orders snapshots and deltas by `seq`
  and resubscribes on a gap or reconnect.
- `src/domain/`: pure logic, covering delta merge, sequencing, decoders, formatting, scales, the layout model, and
  the picker's, Overview's and regime rules (`products.ts`, `overview.ts`, `regime.ts`, `tabs.ts`).
- `src/components/`: the canvas panes (`draw*.ts`) and the panels around them.
- Chart colour layer: every colour, on a canvas or in `index.css`, is read through the one override layer in
  `src/theme.ts` (`themeColor`), so a chart colour role keeps one meaning on every tab. To colour a new mark, read its
  token through `themeColor` or `colors`, never from `design/tokens.ts`; `src/chartColorLayer.test.ts` fails otherwise.
  The roles are listed once in `src/design/chartColors.ts`, and a viewer's colours are kept per theme in this browser's
  localStorage under `futures-liquidity-dashboard.chart-colors.v1` (`src/lib/chartColorOverrides.ts`;
  [a separate change]).
- `src/design/`: the design system's tokens (`tokens.json`, both themes) and the stylesheet generated from them
  (`tokens.css`). `index.css` uses only those custom properties, and `src/theme.ts` gives the canvases the active
  theme's values from the same file ([`ARCHITECTURE.md`](../../ARCHITECTURE.md) D-42). IBM Plex
  Sans and Mono are bundled from npm and precached for offline use (D-43). The top bar's Theme menu switches
  between Terminal and Light; with nothing chosen the page follows the OS setting, and a choice is kept in this
  browser's localStorage only (`src/lib/colorTheme.ts`, D-46). Price up is the blue `up` and price down the grey `down`
  in both themes, always with an arrow or sign; only price-direction marks use them, so a warning reads `danger` and
  the best bid and ask are drawn in `bid` and `ask` (D-48, [a separate change]). Light's ground is a
  warm paper, not white: `surface-lowest` and the heatmap's empty `heat-0` are both `#efede7`, and the other surfaces step
  darker from it (D-50, [a separate change]).
- Chart colours: the top bar's **Chart colours** button (`components/ChartColorSettings.tsx`) lets the viewer recolour
  each chart colour role (up, down, the volume-dot outlines *(2026-11-15, [a separate change])*, bid, ask, the heat stops, VWAP, the EMAs and indicators, the levels, the signal
  biases, the Order Flow events, warmup) for the active theme, with a sample, its worst contrast and a warning below its
  NFR-8 floor; the choice stands either way, and goes through the chart colour layer above (FR-71, D-51, [a separate change]).
- Volume-dot outlines: every volume dot, on Detail and Order Flow alike, has its edge stroked by aggressor side, the buy
  share's arc in `dot-outline-buy` (a green) and the sell share's in `dot-outline-sell` (a red), part by part on a split
  dot, outside a 1px `dot-outline-halo` that keeps it visible on a bright heat cell. Both charts call the one routine,
  `components/volumeDotOutline.ts` (`strokeVolumeDotOutline`), after the fill and before the quantity; to draw a volume
  dot anywhere else, call it too (FR-59, FR-67, D-52, [a separate change]).
- Wheel: while a page or container that can scroll cuts a chart's plot off, the chart leaves the wheel uncancelled so
  that scrolls instead, and a wheel gesture that began by scrolling keeps scrolling until the wheel pauses for 250 ms.
  A page that cannot scroll (the wide layout) does not count, so there a cut-off plot zooms as before. Detail and Order Flow both ask `hooks/useWheelGate.ts` (over `lib/wheelGate.ts`) before they zoom; a
  new chart that zooms on the wheel asks it too (FR-67, FR-68, D-53, [a separate change]).
  A chart plot is never taller than the window: `index.css` caps the Order Flow stage and the Detail price pane at
  `100svh` and lets their minimums (420 px, 280 px on a phone, and 220 px) yield to it, so in a short window the chart
  shrinks and can always be scrolled wholly into view, where the wheel zooms it. A new chart that zooms on the wheel
  is capped the same way (D-53, [a separate change]).
- Price controls: Detail and Order Flow show one Price group, `components/PriceControls.tsx` (+, −, Fit, Center and
  Lock), over one behaviour, `hooks/usePriceControls.ts`. Lock is the saved `centerPrice`, one setting for both tabs,
  and what turns it off (a price zoom, Fit, a 4 px vertical drag, a 2 px vertical pinch) is decided there and in
  `domain/priceLock.ts`; a sideways drag and a time zoom leave it on. A chart that gets price controls renders that group
  and hands the hook its own shift and zoom (FR-67, FR-68, D-54, [a separate change]).
- Hints: `components/Hint.tsx` explains a control that is not obvious from its label, in one sentence (D-47). It shows
  on hover and on keyboard focus, and on touch through an ⓘ button beside the control. The control references it
  with `aria-describedby`; Escape, blur and the pointer leaving hide it. It never uses a native `title`. To hint a
  control, add its sentence to `src/domain/hints.ts` and wrap the control: `<Hint label="Live" text={hints.live}>
  {(hint) => <button {...hint}>Live</button>}</Hint>`. The Order Flow presets, heat modes, contrast, Live, each
  Display-menu item and the 5m/15m regime labels have one; interval, window and zoom buttons do not.
- `src/hooks/`, `src/routes/`, `src/lib/`: React wiring, the route and its loader, and browser helpers.

## Tabs: Overview and Detail

The page has three tabs, in the top bar's order Overview, Detail and Order Flow. **Order Flow** (`?tab=orderflow`;
`?tab=bookmap` still opens it) charts the selected product on one price scale with the book and profile docked
beside it ([`ARCHITECTURE.md`](../../ARCHITECTURE.md) D-36). **Detail** (the default) is the picker and one product's charts, as described below.
**Overview** is one table of every product from the polled `GET /api/instruments` list, headed "All products" with the
shown and total counts and a chip with a count for each feed status present (LIVE, REPLAY and so on). Its filter row
holds the filter field, "Group by sector" (once a column is sorted) and, in the native shell, Change server. Each row
has a watchlist star (the picker's: it keeps or drops the product's depth, and is disabled when the watchlist is full)
beside the product's button, and shows the last price, the change from the session open with a ▲ or ▼, session high
and low, volume, spread in ticks, trade rate, Δ60s and CVD with a direction arrow, the regime on 5- and 15-minute
bars, whether those agree, the newest signal with its age and the count of signals in the last 15 minutes, and the
feed's status (with `no DOM` where the server holds no depth). It is grouped like the picker (watchlist, then sectors,
each heading counting its products) until a column header sorts it, which goes ascending, then descending, then back
to grouped; the same filter as the picker narrows it, and a product's button opens it on Detail. While Overview
is shown no chart is mounted or drawn; the hub connection stays up so the watchlist keeps its depth.

The tab is kept in the URL (`?tab=overview`; Detail takes the parameter out) and in this browser, the URL winning.
Switching tabs does not re-run the route loader.

### Regimes

Each product's summary carries one regime per bar timeframe (300 and 900 seconds by default), shown as
`Trend ↑`, `Trend ↓`, `Range`, `Unclear` (the server's Transition) or `Warming n/m` while the bars warm up. The
tooltip gives ADX, the efficiency ratio, the fast and slow EMAs (as prices) and since when the state has held. The
5m/15m marker reads **Agree** when both trend the same way or both range, **Conflict** when they trend opposite ways
or one trends while the other ranges, and **Mixed** when either is unclear, warming up or missing. A trend name the
dashboard does not know reads as warming, and a regime entry it cannot read is skipped, so the server can add
regime kinds later. Detail shows the selected product's two regimes in the status bar, from the same polled list.

## Products, the watchlist and depth

The product list is not fixed in the dashboard: it comes from `GET /api/instruments` (seeded by the route loader,
then re-read every 2 s while the page is visible, paused while it is hidden). On Detail the status bar, the chart
toolbar and the product picker sit above the chart workspace, which fills the rest of the viewport; the loading placeholder occupies
that same chart row until a snapshot arrives. The workspace is the chart column (price chart and indicator dock, D-39) beside a side column about 300 px wide
(D-45): the depth ladder, the liquidity metrics, the signals, the levels and the Layers toggles, stacked and always visible,
with the volume profile added when a profile window is on. It is a `flex-wrap` row, so under 900 px the column drops
below the charts; above that it scrolls inside itself. The button at the right of the indicator dock's tab strip (*Indicator dock*,
`aria-expanded`) collapses the dock to that strip, and the price chart takes the freed height; picking a tab expands
it again. The choice is saved with the layout as `indicatorDockCollapsed` ([a separate change]). ~~The side column has no fold and no tab strip.~~ *(2026-11-15, [a separate change]: the column still has no fold or tab strip of its own, but each section in it folds to its heading. The heading is a button (`aria-expanded`, `aria-controls`) that folds the section's body away and keeps the heading in place; the profile's window picker folds with its section. The folded sections are saved with the layout as `sideSectionsCollapsed` (keys `ladder`, `liquidity`, `signals`, `levels`, `profile`, `layers`), every section open by default; `src/components/SidePanel.tsx` draws each section, D-49.)* The picker opens collapsed to one row (D-44): a
*Products n* button, the watched products as small buttons (a star and the root; the name, last price and change are
in each button's tooltip) and the filter field at the right. The button expands it, and typing in the filter expands it
too. Expanded, it lists every product, the watchlist first and the rest by sector, with the last price, the change from
the session open, the spread in ticks, session volume, CVD, the feed status and a `DOM` mark where the server holds the
product's depth, capped at about a third of the viewport and scrolling inside that cap. A filter narrows it and a row's
button selects the product the charts show. A viewer's own expand or collapse choice is kept in this browser; until
there is one, the row is collapsed. Overview is a separate tab
and does not use this panel.

Only the selected product is charted: the server pushes chart deltas for the subscribed product alone. The star
adds a product to the watchlist (at most 12). The dashboard sends the watchlist to the hub's `SetWatchlist` on
connect, on every reconnect and whenever it changes, so the server pulls depth for watched products and their
heatmap history is there before you switch to them. A star the server refused (over its depth cap, unknown or not
permitted) turns hollow amber. A product without depth streams trades and quotes only: the chart says so, and its
heatmap and DOM stay empty.

## Chart keyboard

The main chart is a focusable control (Tab to it). Arrow keys move a cell one bar or one price tick, Shift+arrow
left/right pans by one bar, Shift+arrow up/down and Shift plus or minus zoom price, plus and minus zoom time, and
Home returns to the live edge. Escape clears the cell and leaves the chart. After a pan or zoom the cell stays on
a bar that is still in view. The hint is shown only while the chart has keyboard focus. Wheel, drag and
double-click are unchanged, and moving the pointer does not speak: the polite live region follows the keyboard
cell only. That readout is Chicago time, OHLC, volume, and the bid, ask and coverage at the focused price. A
forming bar is not announced again until the numbers have settled.

## Measuring

Open the page with `?perf=1` to record frame times (a requestAnimationFrame loop) and the main chart's draw times,
the last 600 of each, on `window.__dashPerf` (`frames`, `draws`, `reset()`), with a small p50/p95 readout in the
corner. Without the flag none of it runs.

`node scripts/measure-frames.mjs` (from the repository root, with the API and this dev server already running)
records those samples while the synthetic feed streams and while the chart is panned and zoomed, plus the size
and latency of `GET /api/instruments`. It is opt-in. It is not a CI gate.

## Layout settings

The selected product, the interval, the history window, the watchlist and the pane and signal toggles are saved to
`PUT /api/layouts/me` and, on every change, to this browser's localStorage. The API keeps one revision counter per
viewer in memory for the process. A PUT is accepted only when its `revision` is that counter; the response carries
the next value. A mismatch answers 409 with the layout still stored. When that document was saved, the page shows
it. When the server has nothing saved, the page keeps its local layout and puts it again at the revision in the
409. After a restart `GET /api/layouts/me` reports `saved: false` and `revision` 0, and the page puts
a local copy back only when the stored document matches the layout schema. The chart toolbar shows which store the
last successful read or write used.
