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

## Sign-in

When the API's `GET /api/auth/config` names an OpenID Connect provider (`Auth__Oidc__*`,
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) D-77), the browser signs in with it instead of asking for a key: the
Authorization Code flow with PKCE, as a public client, redirected to `/auth/callback` (`src/lib/oidc.ts`,
`src/components/SignInGate.tsx`). The access token is kept in `sessionStorage` for the tab, refreshed before it
expires, and sent as `Authorization: Bearer` on `/api` and as the SignalR access token on `/hubs/market`, in the
key's place. **Sign out** ends the provider's session. The provider must list `<dashboard origin>/auth/callback` as a
redirect URI and the dashboard origin as a web origin. The Android shell keeps the key prompt.

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
  the picker's, Overview's and regime rules (`products.ts`, `overview.ts`, `regime.ts`, `tabs.ts`), and the Conditions
  panel's fixed states (`conditions.ts`).
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
  A chart plot is never taller than the window: `index.css` caps the Order Flow stage and the Detail main chart pane at
  `100svh` and lets their minimums (~~420 px~~ 252 px since [a separate change], with the indicator dock's 168 px under it, 280 px on a phone, and 220 px) yield to it, so in a short window the chart
  shrinks and can always be scrolled wholly into view, where the wheel zooms it. A new chart that zooms on the wheel
  is capped the same way (D-53, [a separate change]).
- Price controls: Detail and Order Flow show one Price group, `components/PriceControls.tsx` (+, −, Fit, Center and
  Lock), over one behaviour, `hooks/usePriceControls.ts`. Lock is the saved `centerPrice`, one setting for both tabs,
  and what turns it off (a price zoom, Fit, a 4 px vertical drag, a 2 px vertical pinch) is decided there and in
  `domain/priceLock.ts`; a sideways drag and a time zoom leave it on. A chart that gets price controls renders that group
  and hands the hook its own shift and zoom (FR-67, FR-68, D-54, [a separate change]).
- Detail's main chart: the footprint by default, or the price chart, from the *Main chart* group (Footprint, Price)
  before the Price group; the choice is saved as `detailChart`. Both are drawn inside the one `components/MainChart.tsx`,
  which draws `drawFootprint.ts` when its model carries a `footprint` layer and `drawMainChart.ts` otherwise, so the
  drag, wheel and its gate, keys, the Price group and Lock are the same code on both. The footprint draws one row per
  price tick on the price window, fitted to the footprint bars in view, and its delta row sits above the time axis.
  The indicator dock's first tab is Volume (`drawVolumePane.ts`), whose warmup bars are marked by Order Flow's
  `volumeStripBars` (FR-22, FR-41, FR-61, D-55, [a separate change]).
- The indicator dock (`components/IndicatorDock.tsx`) sits under the Order Flow chart as well as under Detail's, in
  place of Order Flow's old volume strip and CVD subchart. Both tabs show the tab `indicatorPane` names and collapse it
  on `indicatorDockCollapsed`, so a choice on one shows on the other. On Order Flow the dock takes the stage's window,
  so a drag, a zoom and the wheel gate move both, and its time-series tabs leave the PRICE, COB and SVP columns' width
  at their right (`axisWidth`), so a time sits at the same x on the dock as on the plot. The CVD tab draws the warmup
  stretch in the warmup grey and the live stretch in `up` or `down` by the sign of the session CVD, on both tabs, on a
  scale fitted to the CVD in view with the zero guide only when zero is in range (D-48, FR-22, FR-45, FR-61, FR-67, D-56, [a separate change]).
  The RSI, MACD and ATR headers name each value they show, `MACD 12/26/9  Line 2.00 · Signal 0.75 · Hist 1.25`,
  `RSI 14  Value 54.3` and `ATR 14  Value 2.25`, and say `warming up (n/N)` with no value until the series is ready.
  `Hist` is short only on the chip, to fit a phone; the pane's hidden summary spells out `Histogram`
  (FR-19, FR-20, FR-21, [a separate change]).
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
beside it ([`ARCHITECTURE.md`](../../ARCHITECTURE.md) D-36), and the indicator dock below it (D-56). **Detail** (the default) is the picker and one product's charts, as described below.
**Overview** is one table of every product from the polled `GET /api/instruments` list, headed "All products" with the
shown and total counts and a chip with a count for each feed status present (LIVE, REPLAY and so on). Its filter row
holds the filter field, "Group by sector" (once a column is sorted) and, in the native shell, Change server. Each row
has a watchlist star (the picker's: it keeps or drops the product's depth, and is disabled when the watchlist is full)
beside the product's button, and shows the last price, the change from the session open with a ▲ or ▼, session high
and low, volume, spread in ticks, trade rate (tagged `thin` while the tape is thin, FR-83), Δ60s and CVD with a direction arrow, the regime on 5- and 15-minute
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
Overview cell's tooltip gives ADX, the efficiency ratio, the fast and slow EMAs (as prices) and since when the state has held.
*(2026-11-19, [a separate change], REQUIREMENTS.md FR-56.)* The status bar's 5m/15m badges explain themselves in their hint (hover, keyboard focus, or the ⓘ toggle on touch;
`aria-describedby`, so a screen reader reads it with the badge): the verdict, a sentence naming the test that decided it
beside the thresholds it was judged against, then ADX, the efficiency ratio, +DI, −DI, both EMAs and since when
(`regimeExplanation` in `domain/regime.ts`). The server names the test (`basis`) and sends the limits (`thresholds`);
the dashboard only prints them, each threshold exactly as sent and ADX and ±DI to 2 places and the efficiency ratio to 3,
the precision the server rounds them to, so a value just short of a limit never prints as the limit. An older server that
sends neither reads as "Limits not published by this server"; a `basis` this dashboard does not list reads as `Unknown`,
and the hint says the server named a test it does not read rather than claiming one. The
5m/15m marker reads **Agree** when both trend the same way or both range, **Conflict** when they trend opposite ways
or one trends while the other ranges, and **Mixed** when either is unclear, warming up or missing. A trend name the
dashboard does not know reads as warming, and a regime entry it cannot read is skipped, so the server can add
regime kinds later. Detail shows the selected product's two regimes in the status bar, from the same polled list.

### Net liquidity flow

*(2026-11-19, [a separate change], REQUIREMENTS.md FR-76.)* The Liquidity panel's flow table has a **net** column after added, pulled and filled: the server's `netFlowBid` or `netFlowAsk` for that side and window (added − pulled; a fill is not part of it), as a signed number and a small bar from a centre line, to the right (`flow-net-up`) for a side that is building and to the left (`flow-net-down`) for one that is thinning. The sign is the `+` or `−` in the text and the bar's side; the `up` and `down` colour is a third cue, and zero has no bar and no colour. A bar is scaled within its window to the larger of the two sides' magnitudes. The column heading says "(added minus pulled)" to a screen reader and a line under the table says it to everyone. The panel does not draw FR-38's fill-adjusted `netBid` and `netAsk`, which stay on the wire; the schema (`src/api/schemas.ts`) names only the new pair, and the client never computes either.

### Conditions

*(2026-11-19, [a separate change], REQUIREMENTS.md FR-81, ARCHITECTURE.md D-67.)* Detail's side column has a **Conditions** section after the
depth ladder (`components/ConditionsPanel.tsx`): eight fixed rows, in this order, each with its name, what it reads, the
values it compared and its definition. Price vs VWAP, Price vs POC and Price vs value area compare the current book: above
when the best bid is over the level, below when the best ask is under it, at when the level is within the spread (for the
value area, inside when bid and ask are both within VAL–VAH). EMA 13 vs EMA 48, RSI 14 vs 50 and MACD vs its signal line
read the last closed value of the layout's indicator timeframe, never the developing one. Compared values print at the
instrument's places, or with up to six more when two unequal values would otherwise print the same. The 5m and 15m regimes are the
server's, from the polled summary (`DashboardRoute` hands them to `MarketView`); the browser classifies nothing. A reading
that is not a state (`warming n/m`, `partial`, `stale quote`, `no quote`, `not published`, `no closed value`, `no VWAP
yet`, `no session profile`) is muted and italic, and its `data-reading` names its kind. States are uncoloured text, and a
note under the list says they carry no score, forecast or suggested action. The rules are `domain/conditions.ts`
(`conditionsFor`); nothing new comes over the wire.

### Range zones

*(2026-11-19, [a separate change], REQUIREMENTS.md FR-75, ARCHITECTURE.md D-62.)* The snapshot and its deltas carry, per regime
timeframe, the stretches the server's own classifier called Ranging (`rangeZones`; a delta carries them only when they
changed). Detail's price and footprint charts and Order Flow shade the zones of the layout's `rangeZoneTimeframe`
(`300`, the default, so zones show within the replayed history, `900` or `off`) as a box in the `range-zone` token at `RANGE_ZONE_FILL_ALPHA` (0.12), from half a
tick under the zone's low to half a tick over its high, with a hairline top and bottom edge and no label or tooltip
(`components/drawRangeZones.ts`). The box sits behind the price marks (over the price chart's opaque heat ground,
behind Order Flow's heat), is clipped to the plot, pans and zooms with the chart and never changes the price fit.
Inside Order Flow's warmup band only the edges are drawn. Detail's Layers panel has the **Range zones** toggle (the
`range-zones` pane flag, on by default) and the **bars** select; Order Flow's Display menu has the same two as buttons.
Both are saved on the layout, so the tabs always agree. The dashboard never classifies a regime itself.

### Level touches

*(2026-11-19, [a separate change], REQUIREMENTS.md FR-79, ARCHITECTURE.md D-65.)* Each level the server counts touches for carries `held`
and `broke` beside `touches`: a touch broke when a closed minute closed at least 2 ticks beyond the level on the far
side from where price came, and held otherwise (an open touch reads as held until a closed minute breaks it). The
server judges it over every retained closed minute, like the touch counts, not only the current session; the dashboard only formats it, with
`touchOutcomeText` in `domain/quote.ts` (`2 touches · 1 held · 1 broke`, `3rd touch · …`, or `no touch yet`). The
touch lane under the favorites (`components/InstrumentTabs.tsx`) lists the starred products' touches first, then the
most recent touch, with root, level name and price breaking ties (`recentTouches`), so a refresh that lists the
products in another order draws the same lane. Each chip is a button that opens its product in Detail, from Order
Flow as well. Detail's **Levels** side section (`components/OverlayPanel.tsx`) lists the open product's levels,
highest first, with the same text, above the agent overlay; the price chart's level hover lines and the favorites
menu's nearest-level line say it too. None of it is a forecast.

### Signals panel

*(2026-11-19, [a separate change], REQUIREMENTS.md FR-80, ARCHITECTURE.md D-66.)* Detail's Signals panel lists the signals newest first, one
toggle per kind (a kind the server adds later has no toggle and is always listed). Its **Iceberg floors** (strength in percent, hidden size in contracts; 0 hides none) are saved on the
layout and leave the icebergs below them out of this list only; each kind's toggle then says how many the floors hide
(`n below floors`). Icebergs on one side, each within 4 ticks and 60 s of the previous one, are one row with the price
range, the count, the summed hidden lower bound and the strongest member; **Show n icebergs** lists the members. A closed row mounts no members: they render when it is opened and unmount when it is closed, at most 50 (`MEMBER_LIST_LIMIT`) with a `+N more` line (`+N more rows` in a group, which counts rows, not signals), and the row components are memoised, with a row whose signals did not change (the same `Signal` objects, not merely the same ids, which restart from 1 when the server does) keeping its object between renders so a stream update or an unrelated signal does not re-render it ([a separate change]). The
*inferred from prints and book changes, not exchange order ids* sentence is shown once, under the floors, while icebergs
are on. The floors, the runs and the sentence are `src/domain/signalClusters.ts`; the chart, the ladder and the Overview
are not filtered. A run closes once it has been idle longer than 60 s, and the rows are memoised on the signals,
the kind toggles and the floors, so a 3-day history stays inside the frame budget. The strength floor compares
the whole percent a row shows, so an iceberg read as `40 %` passes a 40 floor *(2026-11-19, [a separate change], answering a review note on [a separate change] for [a separate change])*.

*([a separate change], REQUIREMENTS.md FR-82, ARCHITECTURE.md D-69.)* Signals of two or more kinds whose prices lie within 6 ticks of one
another and whose times lie within 5 minutes of the first are one **group** row: the kinds with their own strengths,
the price range, the time span and the count, with no bias colour or verdict; **Show n signals** lists the members
(an iceberg cluster is one). Signals of one kind never group, and the kind toggles and floors apply first. While the
pointer or focus is on a group row the main chart shades its price range (`components/GroupBand.tsx`); **Mark on
chart** keeps it shaded until pressed again, the instrument changes or the group is no longer listed. `MarketView`
holds only the group's key (its first signal in time) and looks its current range up in the rows `useSignalRows`
lists, so the shading follows the group as it grows and goes when it goes.

Detail's price chart names its overlay lines on the price axis (`components/drawLineTags.ts`, `domain/lineTags.ts`; [a separate change], REQUIREMENTS.md FR-77, D-63): one tag per visible line, the session VWAP and its ±1σ and ±2σ bands and each shown EMA, at the price the drawn line has at the chart's right edge (the developing value at the live edge, or the line's interpolated value there when panned back; an EMA with no visible segment of its line has no tag; `emaPath` decides both), in the column the last-price, bid and ask tags use. A tag is a chip with the words in the strong ink and the line's token as a bar and outline; an EMA still warming up reads `EMA48 warm`. Tags that would overlap each other or those price tags stack apart, and a line outside the visible price range has none. The Layers toggle **Line tags on the price axis** (the `line-tags` pane flag, on by default) turns them off and is saved on the layout. The footprint chart draws no EMAs and Order Flow already names its VWAP guide, so neither changes. The agent Levels (the `overlay` pane) are on by default too, so the Levels panel shows them instead of "Hidden on the chart"; a layout that saved `overlay` false keeps them off.

### Thin tape

*(2026-11-19, [a separate change], REQUIREMENTS.md FR-83, ARCHITECTURE.md D-70.)* The server judges each product's tape against its own
recent median trade rate and sends `tape` (`state`, `rate`, `baselineRate`, `thinBelowRate`, `baselineMinutes`) on
`liquidity` and on the Overview summary, and `thinTape: true` on a signal raised while the tape was thin. The client
recomputes nothing: `src/domain/tape.ts` words the state and the hint from the server's numbers. The Liquidity panel
shows **Tape** (`active`, `thin` or `no reading`) under the trade rate, with the rate, the median and the limit in its
hint; the Overview's Rate cell carries a `thin` tag. A thin-tape signal's row in the Signals panel is tagged
**thin tape** and its dot and kind dimmed, an iceberg cluster or a multi-kind group (FR-82) says how many of its signals were, and its marker on the Detail
price chart and on Order Flow is drawn at `THIN_TAPE_ALPHA`; the price chart's hover adds `thin tape when raised`.
Nothing is hidden, and the words describe activity, never direction.

## Products, the watchlist and depth

The product list is not fixed in the dashboard: it comes from `GET /api/instruments` (seeded by the route loader,
then re-read every 2 s while the page is visible, paused while it is hidden). On Detail the status bar, the chart
toolbar and the product picker sit above the chart workspace, which fills the rest of the viewport; the loading placeholder occupies
that same chart row until a snapshot arrives. The workspace is the chart column (main chart and indicator dock, D-39, D-55) beside a side column about 300 px wide
(D-45): the depth ladder, the conditions, the liquidity metrics, the signals, the levels and the Layers toggles, stacked and always visible,
with the volume profile added when a profile window is on. *(2026-11-19, [a separate change], REQUIREMENTS.md FR-78, ARCHITECTURE.md D-64.)* The
liquidity metrics' Walls line lists, after the standing walls, the last walls that ended (`Ended:` price, mostly filled,
mostly pulled or below threshold, how long it stood and how long ago it ended; the title gives the side, the peak and the split),
and the depth ladder marks each of their prices with ▯, adding an empty row inside a side's shown range when the level
is gone (`src/domain/walls.ts`, `src/components/LiquidityPanel.tsx`, `src/components/DomLadder.tsx`). The depth ladder follows the inside of the book ([a separate change], REQUIREMENTS.md FR-36): a layout effect centres the spread row in the ladder's own scroll box (never the page) on every update, with at most one scroll write, so rows added or removed above it do not move it. The component tells its own write from a viewer's scroll by position (recorded after every update, even when no write was needed, and `overflow-anchor: none` on the box so the browser does not shift it), so a wheel, drag or keyboard scroll pauses following (the box takes Tab focus, and a wheel, a navigation key or a press in the box pauses at once, before the scroll event) and the **Centre** button, always drawn and disabled while following, is enabled; it re-centres, returns focus to the ladder without scrolling the page, and resumes. The words say how
the size left, never why. It is a `flex-wrap` row, so under 900 px the column drops
below the charts; above that it scrolls inside itself. The button at the right of the indicator dock's tab strip (*Indicator dock*,
`aria-expanded`) collapses the dock to that strip, and the price chart takes the freed height; picking a tab expands
it again. The choice is saved with the layout as `indicatorDockCollapsed` ([a separate change]). ~~The side column has no fold and no tab strip.~~ *(2026-11-15, [a separate change]: the column still has no fold or tab strip of its own, but each section in it folds to its heading. The heading is a button (`aria-expanded`, `aria-controls`) that folds the section's body away and keeps the heading in place; the profile's window picker folds with its section. The folded sections are saved with the layout as `sideSectionsCollapsed` (keys `ladder`, `conditions` *(2026-11-19)*, `liquidity`, `signals`, `levels`, `profile`, `layers`), every section open by default; `src/components/SidePanel.tsx` draws each section, D-49.)* The picker opens collapsed to one row (D-44): a
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
forming bar is not announced again until the numbers have settled. On the footprint main chart a cell is one footprint
column, whatever the candle interval, and the readout is that column's volume and delta and the volume traded at the bid
and at the ask at the focused price, the cell's own two numbers, never the resting depth (D-55, [a separate change]).

## Simulated position

*(2026-11-18, [a separate change], REQUIREMENTS.md FR-72, ARCHITECTURE.md D-58.)* One simulated position per product, saved on the
layout and shown on Detail (price and footprint) and Order Flow. **Alt-click** the plot to place a limit entry at the
clicked tick: a long at or below the last price, a short above it. A plain click or drag still pans; an Alt-press does
not. The entry, stop and each target are lines across the plot, each labelled **SIMULATED** with its price on the price
axis; drag one to move it on the tick grid. A drop that breaks FR-72's rules springs back and the reason shows on the
plot and in the ticket. The ticket above the chart (`PositionTicket.tsx`) edits side, type, quantity, entry, stop and
targets from the keyboard (until the entry fills, below): Tab between fields, Enter or leaving a field applies it, Escape restores it. **Place at last
price** places one without a pointer, **Clear** removes it, and **Feedback** (below) appears only when the server offers it. The
rules and the edits live in `domain/positionEdit.ts`, the lines in `PositionLines.tsx`, and `hooks/usePosition.ts`
saves each change through the layout's `update`, which marks `positions` as changed (D-57).

**Tracking** *(2026-11-18, [a separate change], REQUIREMENTS.md FR-72, ARCHITECTURE.md D-59.)* The browser paper-tracks the position
against the live prints it already receives, only while its product is on show. `domain/positionTrack.ts` holds the
rules: a limit fills only on a print strictly through its price, a market entry at the next print, the stop at the first
print at or through it, targets on a print through them with scale-out. The ticket shows the state, each exit with its own
P&L, and the open, realized and total P&L in ticks, currency and R (R is fixed at the fill, stored as `fill.riskTicks`).
Warmup prints and prints while the feed is DEGRADED or otherwise untrackable fill nothing, and the ticket says "not
tracked since HH:MM CT" across a gap. A per-product heartbeat in `localStorage` (`futures-liquidity-dashboard.position-beat.<root>`)
lets a switch between Detail and Order Flow carry on from the last print, and shows the time the tab was closed as not
tracked. Once the entry fills, side, type, quantity and entry are locked, a filled target cannot be edited, a live target
cannot move to or inside a filled one, and a closed position can only be cleared.

**Feedback** *(2026-11-19, [a separate change], REQUIREMENTS.md FR-74, ARCHITECTURE.md D-61.)* The ticket's **Feedback** button asks the server for commentary on
the position (`POST /api/plans/feedback/{root}`, once per press, disabled while it runs, never retried or refreshed).
**It is hidden by default**: no button and no panel exist until `GET /api/plans/feedback/status` (read once per product on
show) says `available`, or says only that the month's budget is spent. No key, disabled, a 403 (no `request-feedback`
grant) or no answer all leave it hidden (`domain/feedback.ts` `feedbackOffered`, the maintainer's ruling of 2026-11-18).
The panel (`FeedbackPanel.tsx`) sits **to the right of the chart**, under it below 900 px: a header with the as-of time in
CT, a summary, one section per leg (Entry, Stop, Targets) with
its fill likelihood as text, the assessment, the suggestion (`→ price, why`) and a `cites:` line whose every metric shows
its value from the same response (`citedValues`), then the risks, how many claims the server removed (`droppedCites`, shown as "claims removed"). The advisory label and, whenever the reply's provider is `mock`, a **MOCK** label beside it sit in a footer outside the scrolling answer, so both stay in view. Each suggestion is also a dashed
**ghost line** on the chart (`PositionLines.tsx`); one click, or the Apply button in the panel (the keyboard way), sends the
move through `moveLine`, so FR-72, the filled-position rules and the scale-out reorder rule can refuse it with the reason.
Feedback goes **stale** (a banner, ghosts removed, Apply disabled) once the position changes or the last price moves more
than 1 ATR from the as-of price (`staleReason`); it never refreshes on its own. The other states: loading, metrics only
(with the reason), over budget (spend and cap, button kept) and rate-limited. `hooks/useFeedback.ts` holds the state and
`api/feedbackClient.ts` the two calls (a 70 s deadline, 429 and 503 bodies read into `FeedbackRefusedError`).

## Measuring

Open the page with `?perf=1` to record frame times (a requestAnimationFrame loop) and the main chart's draw times,
the last 600 of each, on `window.__dashPerf` (`frames`, `draws`, `reset()`), with a small p50/p95 readout in the
corner. Without the flag none of it runs.

`node scripts/measure-frames.mjs` (from the repository root, with the API and this dev server already running)
records those samples while the synthetic feed streams and while the chart is panned and zoomed, plus the size
and latency of `GET /api/instruments`. It is opt-in. It is not a CI gate.

## Layout settings

The selected product, the interval, the history window, the watchlist, the main chart (`detailChart`), the range-zone bars (`rangeZoneTimeframe`), the Signals panel's iceberg floors (`icebergMinStrengthPercent`, `icebergMinHiddenSize`) and the pane and signal toggles are saved to
`PUT /api/layouts/me` and, on every change, to this browser's localStorage. The API keeps one revision counter per
viewer ~~in memory for the process~~ *(2026-11-19, [a separate change], D-18: with the layout, in one file that survives an API restart)*. A PUT is accepted only when its `revision` is that counter; the response carries
the next value. A mismatch answers 409 with the layout still stored. When that document was saved, the page shows
it. When the server has nothing saved, the page keeps its local layout and puts it again at the revision in the
409. ~~After a restart~~ *(2026-11-19, [a separate change]: when the store has nothing for the viewer, because they never saved or its file was lost or corrupt)* `GET /api/layouts/me` reports `saved: false` and `revision` 0, and the page puts
a local copy back only when the stored document matches the layout schema. A save the server cannot write answers 503
`layout-store-unavailable`; the page keeps it pending at the revision it cited and sends it again on the next edit or load. The chart toolbar shows which store the
last successful read or write used.
