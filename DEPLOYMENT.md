# Deployment

How to configure, run, build, deploy and roll back the Live Futures Liquidity Dashboard. Section numbers (`§3`,
`§10`) are cited from the code. Health checks and metrics are in [`OBSERVABILITY.md`](OBSERVABILITY.md).

## 1. What runs

| Service | Built from | Port | Purpose |
|---|---|---|---|
| API | [`Dockerfile`](Dockerfile) | 8080 | The one deployable (D-11): the API, the SignalR hub, the hosted ingestion with the one market-data session for every instrument, the reference agent, health and metrics. Market state is in memory (D-18); saved layouts and the feedback budget are small JSON files on one volume at `/data` (`api-data` in compose) |
| dashboard | [`src/dashboard/Dockerfile`](src/dashboard/Dockerfile) | 8080 | nginx serving the built single-page app and proxying `/api`, `/health`, `/hubs` (WebSocket upgrade included) and `/metrics` to `API_UPSTREAM`, so the browser stays on one origin and the API needs no CORS policy |
| `unit-tests` (compose profile `test`) | the `test` stage of [`Dockerfile`](Dockerfile) | — | Runs the unit tests while the stage builds; local only |
| TopstepX gateway | external | — | Market data, only with `Feed:Provider=ProjectX`; outbound only ([`INTERFACES.md`](INTERFACES.md) A) |
| Claude Messages API | external | — | Position feedback, only with `Feedback:Provider=Claude` enabled and a key; outbound HTTPS, one call per request a viewer makes, carrying derived metrics and the key ([`INTERFACES.md`](INTERFACES.md) E). Off in production until enabled; the Mock provider in Development makes no call |

No database, cache or identity provider runs (D-16, D-18). The only files the API writes are two small JSON stores
on one `/data` volume: `layouts.json`, every viewer's saved layout and simulated positions (D-18), and
`feedback-budget.json`, the month's Claude spend (D-61). Neither holds a key or credential. The phone app is the
dashboard image, installed as a PWA (§14).

## 2. Invariants

| Invariant | What you see when it breaks |
|---|---|
| **Exactly one API instance per market-data account**, holding one upstream session for every instrument and the one writer of the files on `/data` (D-7, D-11, D-18, T-5). On Railway: one replica and no deploy overlap ([`railway.toml`](railway.toml)) | A second instance opens a second session: the gateway may drop one, each instance shows its own, diverging state, and each overwrites the other's layouts |
| **No order capability is configured or reachable** (FR-6, T-1) | `ReadOnlyGuardTests` fails, or a route or hub method outside [`INTERFACES.md`](INTERFACES.md) appears |
| **A restart or reconnect never labels an old book current** (FR-4, FR-11) | The status says LIVE while `bookKnown` is false; it must say RECOVERING until the settle-window snapshot |
| **A simulated or replayed market never says LIVE** (D-14) | `Feed:Provider` decides the label; nothing else can |
| **Credentials stay on the server** (NFR-6) | ProjectX keys, or the Claude API key (`Feedback__ApiKey` / `ANTHROPIC_API_KEY`), in an image, a log, `.env.example`, the browser bundle or a `VITE_*` variable |
| **Production has no anonymous grants** (D-16, T-4) | `/api/*` answers without `X-Api-Key`. `appsettings.json` ships no anonymous grants; only Development grants all five |
| **Only `/health/live` is anonymous outside Development** (D-30) | `/health/ready`, `/metrics` or `/api/diagnostics/depth-width` answers 200 without a key, unless `Auth__ProtectDiagnostics=false` |
| **Live depth only for an instrument that has been verified** (D-1) | `Feed:Provider=ProjectX` in a shared environment before that: unverified data labelled LIVE |
| **Local ports on 127.0.0.1 unless `API_BIND_ADDRESS` is set** | `API_BIND_ADDRESS=0.0.0.0` publishes the API, and Development's anonymous grants, on the LAN (T-9) |

## 3. Configuration

**Deploy scripts** (`scripts/deploy.sh`, `scripts/smoke-check.sh`) read:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DEPLOY_PROVIDER` | no | unset (`placeholder`) | `railway`, `azure` or `kubectl` (§10). Unset, `deploy.sh` warns and deploys nothing |
| `IMAGES` | yes, to deploy | — | Space-separated image names, deployed in this order |
| `RAILWAY_TOKEN` | when the provider is `railway` | — | A Railway project token scoped to the target environment. Sent in a request header, never printed |
| `RAILWAY_ENVIRONMENT_ID` | no | unset | The Railway environment the token must be scoped to; unset, it must be named `staging` or `production` |
| `DEPLOY_POLL_SECONDS` / `DEPLOY_POLL_ATTEMPTS` | no | `10` / `60` | How long the Railway adapter waits for each deployment |
| `STAGING_URL` / `PRODUCTION_URL` | when a provider is set | unset | Base URL of the smoke check |
| `HEALTH_PATH` | no | `/health/live` | Path the smoke check requests. `/health/live` needs no key; a deeper probe of `/health/ready` sends `SMOKE_API_KEY` as `X-Api-Key`, never in the URL |
| `AZURE_CONTAINER_APP` | when the provider is `azure` | — | Container App base name; `-<environment>` is appended |
| `KUBE_DEPLOYMENT` | when the provider is `kubectl` | — | Deployment to restart; the namespace is the environment |

**The application** reads ASP.NET Core configuration: `appsettings.json`, then `appsettings.{Environment}.json`,
then user-secrets (Development only), then environment variables, where `:` is written `__` (`Feed__Provider`).
Every key has a default in code; none is a secret except the ProjectX credentials and the API keys, which are given
only as hashes.

| Setting (environment form) | Required | Default | Purpose |
|---|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | no | `Production` | `Development` turns on the anonymous grants, the synthetic feed and `/openapi/v1.json` |
| `Feed__Provider` | no | `ProjectX` in `appsettings.json`; `Synthetic` in Development and compose (`FEED_PROVIDER`) | `Synthetic`, `Replay` or `ProjectX` (D-12, D-15). An unknown value fails startup |
| `PROJECTX_USERNAME`, `PROJECTX_API_KEY` | when the provider is `ProjectX` | — | The login user name and API key. Set this pair **or** the older `PROJECTX_API_KEY` (user name) + `PROJECTX_API_SECRET` (key), not both; if both are set, this pair wins. Missing: startup fails naming the variables. Never commit them |
| `ProjectX__BaseUrl`, `ProjectX__WebSocket__MarketHubUrl` | no | the client library's TopstepX URLs | Gateway and market hub ([`INTERFACES.md`](INTERFACES.md) A.1) |
| `Feed__ProjectX__ContractIds__<ROOT>` | no | empty: search | Pin the gateway contract id for a root |
| `Feed__ProjectX__SearchLive` | no | `false` | The `live` flag of contract search and history |
| `Feed__ProjectX__SnapshotSettleMs` | no | `1500` (200–10,000) | How long depth rows are collected after a (re)subscribe before the first snapshot (unverified) |
| `Feed__ProjectX__LevelsPerSide` | no | `50` (5–200) | Levels per side kept from the gateway book. A shorter book is not padded. compose passes a shell or `.env` value through; unset stays 50 |
| `Feed__ProjectX__MaxContracts` | no | `0` (no limit) | Most products the ProjectX feed streams (FR-54) |
| `Feed__ProjectX__Quotes` | no | `true` | Subscribe to quotes for every product, for the top of book of products without depth |
| `Feed__ProjectX__HistoryMinIntervalMs` | no | `650` | Least gap between two history requests, across products |
| `Feed__Depth__Mode` | no | `Watched` | `Watched`: depth for the pinned and watched products; `All`: depth for every product (FR-54) |
| `Feed__Depth__Pinned__0` … | no | `MES`, `MCL`, `MGC` | Products that always have depth, first in priority |
| `Feed__Depth__MaxSubscriptions` | no | `8` (0 = no limit) | Most products with depth at once |
| `Feed__Depth__ReleaseDelayMs` | no | `30000` | How long depth stays after a product's last viewer leaves |
| `Feed__MinHistoryHours` | no | `4` (0–24) | Warmup reaches back to the session open or this many hours, whichever is earlier, and at least as far as the slowest regime timeframe needs and, with `Feed__WarmRegimes` true, far enough to hold 1,005 open-market minutes, which seeds EMA 200 on five-minute bars (D-68); capped at 24 h, and a need past that is logged as `WarmupCapped` |
| `Feed__HistoryConcurrency` | no | `4` | Products whose warmup loads at once |
| `Feed__WarmRegimes` | no | `true` | Load enough history for the slowest regime timeframe (7 hours, FR-56) and to seed EMA 200 on five-minute bars, so the default window is about 17 h 45 min mid-week (D-68). `false` uses `MinHistoryHours` only and shows the regime Unknown, and a slow EMA as warming up, until live bars arrive |
| `Feed__TickMs` | no | `250` | The feeds' status cadence |
| `Feed__Ingest__TradeCapacity` | no | `4096` | Trades waiting per contract (D-32). A further trade is counted and the contract is DEGRADED, not LIVE |
| `Feed__Ingest__DepthLevelsPerContract` | no | `4096` | Distinct pending depth prices per contract; past this the book is dropped and the settle window restarts |
| `Feed__Synthetic__Seed`, `__StepMs`, `__LevelsPerSide` | no | `20261108`, `50`, `20` | The simulator (D-12, D-25); the same seed gives the same market |
| `Feed__Synthetic__OutageIntervalSeconds`, `__OutageDurationMs` | no | `0` (off), `5000` | Simulated outages, to exercise STALE and RECOVERING |
| `Feed__Replay__Path`, `__Loop`, `__Speed` | `Path` for `Replay` | —, `true`, `1.0` | The JSON Lines file ([`INTERFACES.md`](INTERFACES.md) A.5) |
| `Engine__Instruments__0` … | no | `*` | `*` for every product the feed offers, or a list of roots (FR-10, FR-54) |
| `Engine__ExcludeInstruments__0` … | no | none | Roots left out |
| `Engine__Regime__*` | no | timeframes `300`, `900`; ADX 14, efficiency 20, EMA 13/48; thresholds 25, 0.30, 20, 0.20 | The regime (FR-56, D-27) |
| `Engine__Tape__BaselineMinutes`, `Engine__Tape__ThinRatio` | no | `30`, `0.25` | The thin-tape rule: the tape is thin while the trade rate is under this share of its own median 10 s rate over this many minutes. Startup fails if the window is outside 1–1,440 or the share outside (0, 1] (FR-83, D-70) |
| `Engine__SliceMs`, `__RetentionMinutes`, `__HistoryRetentionMinutes`, `__StaleAfterMs`, `__LadderLevels` | no | `1000`, `60`, `4320`, `3000`, `40` (5–200) | Slice length, one-second retention, minute retention (3 days), the STALE threshold (D-14), ladder depth. A book with fewer prices is sent as it arrived |
| `Engine__OrderFlow__*` | no | [`REQUIREMENTS.md`](REQUIREMENTS.md) FR-41–FR-52 | Every order-flow threshold and the `Enable*` switch of each detector; `SignalHistoryCap` (20,000, clamped 1–100,000, D-41) |
| `Api__PublishMs` | no | `250` | Delta period (NFR-1) |
| `Api__PublishTimeoutMs` | no | `1000` | How long one browser may take a delta before its connection is aborted (D-32) |
| `Api__MaxWatchlist` | no | `12` | Most starred products per viewer (FR-55) |
| `Layouts__StorePath` | no | `data/layouts.json` under the content root; `/data/layouts.json` in the image | The file that keeps every viewer's saved layout, simulated positions and revision across restarts (FR-9, FR-72, D-18). A relative path is taken from the content root; one that names a directory (ends in `/` or `\`) fails startup; blank keeps layouts in memory only. Mount a volume at its directory, or a redeploy loses it. A missing or corrupt file starts empty with a warning, and a corrupt or unreadable one is renamed to `layouts.json.corrupt-<UTC time>` before the next save, never overwritten. Holds no key or credential |
| `Auth__Keys__0__Name`, `__KeySha256`, `__Grants__0` … | outside Development | none | API keys: a name, the key's SHA-256 as 64 hex characters, and `permission:scope` grants (D-16). Outside Development the process refuses to start without at least one, unless sign-in is on (D-77). The dashboard viewer needs `view-dashboard` and `configure-layout` |
| `Auth__AnonymousGrants__0` … | no | none; all five in Development | Grants for a request with no key. Startup fails if any are set outside Development |
| `Auth__ProtectDiagnostics` | no | unset: protected outside Development | `true` requires a key for `/health/ready`, `/metrics` and `/api/diagnostics/depth-width` even in Development; `false` leaves them anonymous everywhere. `/health/live` is always anonymous |
| `Auth__Oidc__Enabled` | no | `false` | Sign-in through an OpenID Connect provider (D-77). False keeps the key prompt |
| `Auth__Oidc__Authority` | when sign-in is on | none | The issuer URL, https (for Keycloak, `https://<host>/realms/<realm>`). Its discovery document must name the same issuer |
| `Auth__Oidc__ClientId` | when sign-in is on | none | The provider's public client for the dashboard |
| `Auth__Oidc__Audience` | no | the client id | The `aud` the access token must carry |
| `Auth__Oidc__Scope` | no | `openid profile` | Scopes the page asks for; `openid` is always added |
| `Auth__Oidc__Grants__0` … | when sign-in is on | none | `permission:scope` grants every signed-in viewer gets, e.g. `view-dashboard:*` and `configure-layout:*`. Startup fails without one |
| `Agent__Enabled`, `__IntervalSeconds`, `__FirstRunSeconds` | no | `true`, `60`, `15` | The reference agent (D-17) |
| `Feedback__Enabled` | no | `false`; `true` in Development | Position feedback (FR-74, D-61). False hides it: both feedback routes say it is unavailable, and the POST answers 503 `disabled` |
| `Feedback__Provider` | no | `Claude`; `Mock` in Development, and so in compose | `Claude` calls the Messages API with the key below; `Mock` writes deterministic feedback from the metrics, needs no key and costs nothing |
| `ANTHROPIC_API_KEY`, or `Feedback__ApiKey` | for `Claude` | none | **Secret.** The Claude API key; `Feedback__ApiKey` wins when both are set. Set it only as a service secret or in your shell, never in a file. With `Claude` enabled and no key, startup still succeeds and the POST answers 503 `no-key`. It is sent only to the Messages API and never logged, returned or put in an error (NFR-6, T-10) |
| `Feedback__Model`, `Feedback__Effort` | no | `claude-opus-5-5`, `medium` | The model must be one the code prices (`claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`), so its spend can be counted; effort is `low`, `medium`, `high`, `xhigh` or `max`. Validated at start |
| `Feedback__MaxTokens`, `Feedback__TimeoutSeconds`, `Feedback__MaxRetries` | no | `8000` (1,024–64,000), `60` (5–300), `2` (0–5) | Output cap with thinking included; the whole call's deadline; the SDK's retries of a 408, 409, 429 or 5xx inside it |
| `Feedback__MonthlyBudgetUsd` | no | `100` (0 or more) | The month's Claude spend cap (NFR-9). At or over it the POST answers 429 until the next UTC month. Kept in `Feedback__BudgetStorePath`, so a restart in the same month resumes it. It is a guard, not a bill |
| `Feedback__BudgetStorePath` | no | `data/feedback-budget.json` under the content root; `/data/feedback-budget.json` in the image | The JSON file holding the month, its spend and the cap, written atomically. Mount one volume at `/data` (compose does). One API replica only. A missing file starts the month at zero; so does a corrupt or unreadable one (a file with no `spentUsd`, or a `month` not in `yyyy-MM` form, included), with a logged warning, and it is renamed to `<name>.corrupt-<utc>` before the next write. Blank keeps the count in memory only |
| `Feedback__RequestsPerMinute` | no | `6` (1–60) | Requests one viewer may start in a sliding minute; one more is a 429 `rate-limited`. A viewer may also have only one request in flight |
| `Feedback__ServerFallback`, `Feedback__BaseUrl` | no | `true`, `https://api.anthropic.com` | Opt in to the API's server-side fallback on a refusal; the Messages API origin, HTTPS only |
| `API_UPSTREAM` | no | `http://futuresliquiditydashboard.api:8080` | dashboard container only: the origin nginx proxies to |
| `VITE_API_BASE_URL` | no | empty (same origin) | dashboard build time. Public, inlined into the bundle; leave it empty so the image uses the nginx proxy |
| `FEED_PROVIDER`, `API_BIND_ADDRESS` | no | `Synthetic`, `127.0.0.1` | compose only: the feed, and the host address the API is published on (§2) |

**To make an API key**, generate a random value, give it to the caller, and store only its hash:
`printf '%s' '<your-key>' | sha256sum`. Scopes are an instrument root or `*`; the permissions are `view-dashboard`,
`configure-layout`, `read-context`, `publish-overlay` and `request-feedback` ([`REQUIREMENTS.md`](REQUIREMENTS.md) §2). A viewer who asks for position feedback needs `request-feedback` as well as `view-dashboard` on that instrument (FR-74). Copy
[`.env.example`](.env.example) to `.env` for the names compose reads; never commit real values.

## 4. First run

**Locally, with no credentials (synthetic market):**

1. `docker compose up --build`: the API on `http://localhost:5080`, the dashboard on `http://localhost:5173`. Or
   without Docker: `dotnet run --project src/MarqSpec.FuturesLiquidityDashboard.Api --launch-profile http`, and in
   another terminal `pnpm install && pnpm --filter dashboard run dev`.
2. Check that `http://localhost:5080/health/ready` reports `Healthy` with every instrument `SIMULATED`.

**Against TopstepX (unverified, D-1):**

1. Export exactly one credential pair (§3). From the repository root,
   `dotnet run --project src/MarqSpec.FuturesLiquidityDashboard.Api -- live-smoke --seconds 60` connects to the
   market hub only, for MES, MCL and MGC, and prints quote, trade and depth counts. Exit 3 means
   `StoppedForSessionConflict`: stop, do not retry.
2. Run with `Feed__Provider=ProjectX`. If a root has no contract, a tick size differs from the catalog, or the
   gateway is unreachable, the API stays up, `/health/ready` is Unhealthy, and contract resolution is retried with
   backoff. A refused login or an unknown configured contract id is not retried: ingestion stops and readiness says
   so. Fix it and restart (D-37).
3. Watch `/health/ready` and the `fld_*` gauges ([`OBSERVABILITY.md`](OBSERVABILITY.md)). Do not run this in a
   shared environment until the instrument is verified.

**A hosted environment:** create one service per image (§10), with these settings on the **API** service only:
`Auth__Keys__*` with hashed keys and no anonymous grants, the feed (`Synthetic` until the live feed is verified), and
the ProjectX credentials if the feed is `ProjectX`. Attach one volume to the API service at `/data`, writable by the
image's non-root app user (§10). Point the platform's health check at `/health/live`. The
dashboard service gets no API key and no `VITE_*` key: the viewer types the raw key into the page (D-30). Set
`STAGING_URL` or `PRODUCTION_URL` and `HEALTH_PATH=/health/live` wherever you run the smoke check.

## 5. Images

Each release builds every image **once**, tagged with the version `X.Y.Z` (§12), and deploys that exact image. The
host never builds from source: it pulls the tag `scripts/deploy.sh` names and runs it.

```bash
VERSION=$(bash scripts/check-versions.sh --print)
REVISION=$(git rev-parse HEAD)
REGISTRY=ghcr.io/<owner>      # your own registry
docker build -f Dockerfile --target runtime \
  --build-arg VERSION=$VERSION --build-arg REVISION=$REVISION \
  -t $REGISTRY/futures-liquidity-dashboard:$VERSION .
docker build -f src/dashboard/Dockerfile --target runtime \
  --build-arg VERSION=$VERSION --build-arg REVISION=$REVISION \
  -t $REGISTRY/futures-liquidity-dashboard-dashboard:$VERSION .
docker push $REGISTRY/futures-liquidity-dashboard:$VERSION
docker push $REGISTRY/futures-liquidity-dashboard-dashboard:$VERSION
```

`docker build --target test -f Dockerfile .` runs the unit tests inside the build ([`CONVENTIONS.md`](CONVENTIONS.md)
§8.1). Both images run as a non-root user on port 8080 and carry the version and revision as OCI labels.

## 6. Rolling forward and back

```bash
# point the environment's tag at a known-good X.Y.Z and redeploy (§9, §10)
for img in $IMAGES; do docker buildx imagetools create --prefer-index=false --tag "$img:staging" "$img:1.3.0"; done
bash scripts/deploy.sh staging 1.3.0     # production: the same with "production"
```

A rollback restarts the API, which holds market state in memory (D-18): every instrument goes through warmup and
RECOVERING again, and the current overlay is lost. Saved layouts and simulated positions come back from
`Layouts__StorePath` when it is on a volume. Without one, or with a corrupt file, the page re-sends its local copy when
that copy matches the layout schema.

## 7. Known quirks

| Symptom | Cause | Fix |
|---|---|---|
| Startup fails: "Feed:Provider is ProjectX but no ProjectX credentials were found" | `appsettings.json` defaults to `ProjectX` outside Development | Set the credentials, or `Feed__Provider=Synthetic` |
| Every `/api` call answers 401 outside Development | No anonymous grants and no keys yet | Add `Auth__Keys__*` (§3) and type the raw key into the page (D-30) |
| `/health/ready`, `/metrics` or `/api/diagnostics/depth-width` answers 401 | Outside Development those routes need a key (D-30) | Send `X-Api-Key`, or set `Auth__ProtectDiagnostics=false` when the scraper cannot |
| `/health/ready` is Unhealthy for a while after start | Warmup has not finished or the stream has not started | Wait |
| `/health/ready` stays Unhealthy and the log says the credentials or configuration were refused | The login was refused (D-37) | Fix the credentials, then restart |
| RECOVERING after a ProjectX reconnect | A new epoch: the book is unknown until the settle-window snapshot | None, unless it persists |
| STALE in a quiet market | No event for `Engine:StaleAfterMs` (3 s) | Expected until the gateway's heartbeat behaviour is known |
| The overlay is gone after a restart | In memory only (D-18) | Expected |
| A layout reads `saved: false` after a restart | `Layouts__StorePath` is not on a volume, or the file was missing or corrupt (the API logs a `Layout store` warning at the first layout request); the browser re-sends its valid copy when the server reports nothing saved (D-18) | Mount a volume at the store's directory (`/data` in the image). Meanwhile, reload the dashboard in that browser |
| `PUT /api/layouts/me` answers 503 `layout-store-unavailable` | The API could not write `Layouts__StorePath` (a full or read-only volume), or could not move a corrupt file aside. Nothing was saved and the stored revision is unchanged. The log has a `Layout store ... could not be` error naming the path | Free space or fix the volume's permissions. The dashboard keeps the edit pending and sends it again on the next edit or reload |
| The top bar shows "Market open" on a holiday | Holidays and early closes are not modelled (D-5) | Expected |
| A replay without `Loop` turns STALE when the file ends | The feed ends and the last state stays | Set `Feed__Replay__Loop=true` for a demo |
| The feedback spend reads $0 after a restart, or the budget 429 cleared | No volume at `/data`, so the budget file was lost with the container; or the file was corrupt (a warning names the path, and the bad file is kept as `.corrupt-<utc>`); or the volume is not writable by the app user (`could not be saved` in the log); or the UTC month turned (FR-74, D-61) | Mount the volume; check the log for `feedback budget file`; check the month's real spend in the Anthropic console |
| The first start takes longer early in a session | The warmup window also seeds EMA 200 on five-minute bars, about 17 h 45 min mid-week (D-68; [`ARCHITECTURE.md`](ARCHITECTURE.md) *Performance baselines*) | Expected. Name fewer products (`Engine__Instruments__*`) for a quicker start |
| `GET /api/plans/feedback/status` says `available: false` | `disabled` (`Feedback__Enabled` is false, the production default), `no-key` (Claude with no key) or `budget-exhausted` | Enable it and set the key as a secret, or wait for the next UTC month |
| Feedback comes back `feedback: null` with a `reason` | The model refused, timed out, was rate limited or failed, or its reply failed the schema; the metrics still come back (FR-74) | Read the one `Feedback call` log line for that request: it names the exception's type and the HTTP status the API answered with, never its message. `HTTP 401` is the key and `HTTP 400` the request the API refused |

## 8. Production

- **Feed.** `Synthetic` until an instrument's live feed is verified (D-1); then `ProjectX`, with credentials set as
  service secrets and `Engine__Instruments` listing only verified instruments. Licensing first (NFR-7).
- **Access.** `ASPNETCORE_ENVIRONMENT=Production` (the image default), no anonymous grants, one hashed key per viewer
  and per agent with the least grants it needs. The health check path is `/health/live`.
- **Position feedback** stays off (`Feedback__Enabled=false`, the shipped default) until you turn it on: then set
  `ANTHROPIC_API_KEY` as a service secret on the API service, keep `Feedback__Provider=Claude`, and give
  `request-feedback` only to the keys that should spend it. The cap is `Feedback__MonthlyBudgetUsd` ($100), counted
  from usage and kept in `Feedback__BudgetStorePath` on the `/data` volume, so a redeploy in the same month resumes
  it; without a writable `/data` volume it stays in memory and a redeploy resets it (FR-74, D-61).
- **Layouts.** A volume at `/data` on the API service, so `/data/layouts.json` survives a deploy (D-18).
- **One instance** per market-data account (§2). No horizontal scaling: state is in memory, the files on `/data`
  have one writer, and the session is single.
- **Pinned.** The SDK (`global.json`), every NuGet version (`Directory.Packages.props`), the pnpm lockfile, the base
  images by tag, and the release by its digest (§11).

## 9. Deploying and rolling back

A release to an environment is, in order:

1. Copy what runs now to `:<environment>-previous`, when `:<environment>` already exists. The first deploy of an
   environment has none.
2. Point `:<environment>` at the digest you built (§11).
3. Run `bash scripts/deploy.sh <environment> <version>` and then `bash scripts/smoke-check.sh <environment>`, which
   needs `STAGING_URL` or `PRODUCTION_URL` to answer 2xx on `HEALTH_PATH`.
4. If either fails, point `:<environment>` back at `:<environment>-previous`, deploy that version, and stop. On
   the first deploy there is no previous image: `:<environment>` stays on the new digest, and the rollback is yours.

In the original release pipeline these steps run in a `promote.sh` step that is not part of this repository; the
references to it in `scripts/deploy.sh` mean this sequence. Nothing else in this repository moves a tag.

## 10. Host adapter

`scripts/deploy.sh` is the only file that runs a host command. `DEPLOY_PROVIDER` selects the function: `railway`
(current), `azure` or `kubectl`. Swapping hosts is a change to that function and the names it reads.

**Railway.** Each image in `IMAGES` runs on one Railway service whose source is the moving tag:
`<image>:staging` in the staging environment, `<image>:production` in production. The adapter starts a new
deployment of each service, which pulls the tag again; it never builds from a repository. Before deploying anything
it refuses a token scoped to another environment, a service in that environment that builds from a repository or
runs no image, an image no service (or more than one) runs, and a tag the registry holds no digest for. It then
deploys each service in `IMAGES` order and polls it until `SUCCESS` (or `SLEEPING`), failing on `FAILED`,
`CRASHED`, `REMOVED`, `REMOVING`, `SKIPPED`, an approval it cannot give, or no success within the polls. A
deployment that runs a different digest from the one the registry holds for the tag also fails. The service must be
able to pull from your registry (a credential stored on the Railway service, if the registry is private). Set the
API service to one replica, no overlap, health check `/health/live` with a 300-second timeout, and restart policy
`ON_FAILURE` ([`railway.toml`](railway.toml) holds the same five; an image-source service does not read it, so set
them in the service settings too). `scripts/deploy.sh` changes none of them.

**The `/data` volume.** Attach one volume to the API service at `/data` in each environment; the image already sets
both store paths under it, and the smallest size is plenty. It must be writable by the image's non-root app user: a
platform-mounted volume may be owned by root. Check it at the first deploy: after a layout save `/data/layouts.json`
exists and the log has no `Layout store ... could not be written` error, and after the first paid feedback call the log
does not say `could not be saved`. On Railway, if that check fails, `RAILWAY_RUN_UID=0` runs the API as root, which
fixes the permissions; use it only then. Railway allows one volume per service and no replicas beside a volume, which
this one-replica, zero-overlap service already accepts. A replay file that is not in the image goes on the same
volume, with `Feed__Replay__Path` pointing at it; never put credentials there.

**Another host.** Set `DEPLOY_PROVIDER` to `azure` or `kubectl`, or add a function beside `deploy_railway` and a
matching `case` arm. Keep the tag promotion, the smoke URLs and `HEALTH_PATH` as they are.

To roll back by hand, deploy an earlier `:X.Y.Z`: the tags are the history, every image together (§6).
`--prefer-index=false` copies the image's own manifest; without it, `imagetools create` wraps a single-platform
image in a new index with a new digest, so the tag would name something no release built (§11).

## 11. The digest chain

A tag can move between the build and the deploy (a second build of the same version replaces `:X.Y.Z`), so a deploy
should promote the **digest** the build pushed, not whatever the tag names later:

1. When you push each image, record `<image>@sha256:…` from the push output.
2. Point `:<environment>` at `<image>@<digest>`, and check that the tag names that digest before deploying.
3. Promote to production the digest `:staging` names, never a rebuild, then freeze `:X.Y.Z` on it.
4. Copy every tag with `--prefer-index=false`: the promotion, `:<environment>-previous`, the rollback and the freeze.

A rollback re-points `:<environment>` at `:<environment>-previous`; it is not checked against a record.

## 12. Versioning

Every project carries one **SemVer** version, `<Version>` in `Directory.Build.props`. Each frontend's
`package.json` `"version"` equals it, and `bash scripts/check-versions.sh` fails when any project disagrees or the
version is not a plain `X.Y.Z`. Images are tagged only by version (`:X.Y.Z`, and the moving `:staging`,
`:production` and their `-previous`), never by a commit hash; the commit survives as the OCI `revision` label. A
released version is frozen: bump the version before building the next release. The rules for bumping are in
[`CONVENTIONS.md`](CONVENTIONS.md) §14.

## 13. Promotion flow

Build every image once as `:X.Y.Z` (§5), deploy that digest to staging (§9), smoke-check it, then promote the same
digest to production: production never rebuilds. Tag the released commit `vX.Y.Z` once production is up. Rolling
back is deploying an earlier `:X.Y.Z` (§6).

## 14. The phone app

**The installed website.** A production build of the dashboard is a PWA (`display: standalone`). On an HTTPS site,
Chrome on Android installs it from the browser menu. The service worker precaches only the app shell (HTML, JS, CSS,
fonts, icons, manifest); `/api`, `/hubs`, `/health` and `/metrics` always go to the network. A new deploy installs
the next shell in the background and offers **Reload to update**.

**The Android shell** (`src/dashboard/android/`) is a Capacitor WebView that bundles the built dashboard. It is a
debug build only: there is no signed release APK. To build it you need JDK 21, the Android SDK (platform 36,
build-tools 36.0.0) and `ANDROID_HOME`:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter dashboard build
pnpm --filter dashboard exec cap sync android
cd src/dashboard/android
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

On first launch the shell asks for the server origin that serves `/api` and `/hubs/market`. Use `https://…` for a
deployed server. **Allow cleartext HTTP** is only for a machine on your own LAN or local development, and the page
still refuses an `http` host that is not localhost or a private address (T-9). An emulator reaches the local API on
port 5080 of its host-loopback address, 10.0.2.2; a phone on USB runs `adb reverse tcp:5080 tcp:5080` and opens `http://127.0.0.1:5080`. Do
not set `API_BIND_ADDRESS=0.0.0.0` to reach a phone. The shell asks for the viewer key exactly as the website does
and keeps it in `sessionStorage` (D-30); changing servers drops it. Never commit a keystore or `local.properties`.
