# Conventions

The stack and the rules the code follows. Section numbers (`§3`, `§8.1`, `§11`) are cited from the code, so they
are kept stable.

## 1. Runtime and language

**.NET**

- .NET 10 (LTS), C# `latest`, nullable reference types on, warnings as errors, `AnalysisLevel`
  `latest-recommended`, implicit usings, and file-scoped namespaces enforced as a build error
  (`EnforceCodeStyleInBuild` with the severities in `.editorconfig`).
- These are declared once, in the root `Directory.Build.props`, never per project. The SDK is pinned by
  `global.json` at the repository root.

**TypeScript and React**

- Node.js 24 (LTS), TypeScript `strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride` and
  `noFallthroughCasesInSwitch`; `tsc -b` is part of `build`, so a type error fails the build.
- React 19, function components and hooks only, built by Vite.
- oxlint (`.oxlintrc.json`) with the `react`, `typescript` and `jsx-a11y` plugins, the rules of hooks as errors,
  and `--max-warnings 0`. A disabled rule says why on the same line.

## 2. Dependencies

Every dependency has a stated purpose and a known licence, and every version is pinned once for the whole
repository.

- **.NET:** Central Package Management. Versions live in `Directory.Packages.props`; a project file names a package
  without a version. Framework packages stay on the .NET 10 line. **FluentAssertions stays below 8.0** (v8 is
  commercially licensed; v7 is Apache-2.0).
- **NuGet audit gates every build:** `Directory.Build.props` sets `NuGetAudit`, `NuGetAuditMode=all` and
  `NuGetAuditLevel=low`, and warnings-as-errors turns `NU1901`–`NU1904` into errors. The fix for an advisory is a
  security pin in `Directory.Packages.props` naming the advisory, **never** a suppression.
- **Frontends:** each is its own package in the root pnpm workspace, and the committed `pnpm-lock.yaml` pins
  everything. Install with `pnpm install --frozen-lockfile`; add or bump with `pnpm add <pkg>@<range> --filter
  dashboard`, never by editing the lock. Runtime packages are `dependencies`, everything else `devDependencies`.
  `pnpm audit --prod` is the audit; an advisory is fixed by a bump or an `overrides` entry, never an ignore list.
  Overrides live under `overrides:` in the root `pnpm-workspace.yaml` (pnpm ignores a `"pnpm"` field in
  `package.json`), each with a comment naming the advisory it resolves, and are removed once the parent pins a
  patched range itself. Today there is one: `workbox-build>glob: ^14.0.2`, for the `glob` and `minimatch`
  advisories GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249, because the latest `workbox-build` still pins `glob`
  11; it is build-time only and does not ship.

Main packages: ASP.NET Core (minimal APIs, SignalR) and `Microsoft.AspNetCore.OpenApi`; OpenTelemetry with the
Prometheus exporter; `MarqSpec.Client.ProjectX` for the TopstepX gateway; `Anthropic`, the official Claude SDK, for position feedback (D-61), used in place of a hand-written HTTP client for that one call; xUnit, FluentAssertions, FakeItEasy and
`Microsoft.Extensions.TimeProvider.Testing` for tests. On the frontend: React, react-router, zod,
`@microsoft/signalr`, the IBM Plex fonts, Capacitor, vitest and Testing Library.

## 3. Coding standards

- **The interface is thin.** An endpoint or hub method validates and maps its arguments, calls one service and maps
  the result. Business rules live in the libraries, which never reference the web framework.
- **Parse, don't validate:** raw arguments become typed values (an instrument root, a price in ticks) at the
  boundary.
- **Errors:** catch the narrowest exception you can act on, never swallow one, and never show a caller a stack
  trace, a secret or sensitive data.
- **No secrets in source or shipped configuration** (§6), and no sensitive data in logs, errors or telemetry (§7).
- **Concurrency-safe:** no shared mutable state without synchronization. Each instrument engine is used under its
  own lock.
- **Additive extension:** a new capability is a new method and entry point, not a rewrite.
- **Fluent interfaces are preferred** where a library offers them, and our own builders return the object they
  configure. This is a preference for how code is written, never for which package to pick.
- **Wrap a third-party package behind our own extension class** where it is used in more than one place, and
  unit-test the wrapper so an upgrade that changes behaviour fails a test.

**C#**

- Immutability by default (`record`, `readonly record struct`, `required`, `init`); classes `sealed` unless designed
  for inheritance.
- Constructor injection only; no service locators or ambient state; each library registers itself through an
  `Add<Project>()` extension used by the host and the tests alike.
- `System.Text.Json` with source-generated contexts; `async` all the way with a `CancellationToken` on every I/O
  method and entry point; no `.Result` or `.Wait()`.
- Exhaustive `switch` expressions on enums.
- One `static class <Concept>Extensions` per concept for readable composition (`services.AddIngestion()`).

**TypeScript and React**

- Every response is validated with zod at the boundary (`src/dashboard/src/api/schemas.ts`); a message that does
  not match is refused.
- Routes are created once in `router.tsx` with `createBrowserRouter`, each under an error boundary (§7).
- Components are tested as a user uses them (§8).

## 4. The web interface

- ASP.NET Core minimal APIs (`Api/Endpoints/`) and one SignalR hub (`Api/Hubs/MarketHub.cs`) on Kestrel, port 8080
  in the container; logs go to standard output.
- Routes are nouns under `/api/{resource}/{instrument}` and return typed `Results<…>` unions, so the generated
  OpenAPI document states every status. Hub methods are verbs; server messages are named constants (`delta`).
- Every route and hub method is read-only except `POST /api/overlays/{instrument}` and `PUT /api/layouts/me`, and
  **no entry point may offer an order capability** (FR-6, guarded by `ReadOnlyGuardTests`).
- The caller's grant is checked against the instrument before any data is read. Misconfiguration fails at startup,
  before the first request.
- The contracts are in [`INTERFACES.md`](INTERFACES.md).

## 5. Outbound calls and resilience

- HTTPS only, with certificate validation on.
- Transient faults are retried with exponential backoff and jitter; authentication failures are never retried (a
  refused login stops ingestion, D-37).
- On exhaustion, degrade deterministically: report what is known as partial or unavailable, never fabricate.
- The only outbound dependency is the TopstepX gateway, through the client library's own retry and reconnect
  policy ([`INTERFACES.md`](INTERFACES.md) A.5); ingestion restarts a failed stream with backoff from 1 s to 30 s.

## 6. Configuration

- **Environment variables are the primary channel** for settings and secrets; locally, compose passes them through
  from your shell and `dotnet user-secrets` can hold the ProjectX credentials. Every setting is listed in
  [`DEPLOYMENT.md`](DEPLOYMENT.md) §3.
- **.NET:** strongly typed options bound from configuration and validated on start
  (`AddOptions<T>().Bind(...).ValidateOnStart()`), so misconfiguration fails at startup. `appsettings.json` holds
  defaults only, never credentials or endpoints that vary per environment.
- **Frontend:** everything a frontend is built with is public. Vite inlines `VITE_*` into the bundle, so those hold
  only public values (the API base URL), **never a key or a token**. They are parsed once in `src/config.ts`.

## 7. Logging and observability

- One logging abstraction: libraries log through `ILogger<T>` with source-generated `LoggerMessage` methods; the
  host chooses the providers (console, debug, EventSource).
- **Structured logging only**, with named properties, never string interpolation.
- **Never log a credential, an API key, a bearer token or an `Authorization` header**, at any level; the API
  redacts keys from messages, state, scopes and exceptions (§11).
- Metrics labels stay bounded ([`OBSERVABILITY.md`](OBSERVABILITY.md) §2).
- **Frontend:** no `console.*` in shipped code (SignalR's own diagnostics are kept off the console too); a route's
  error boundary shows a categorised message, never a stack trace.

## 8. Testing

Two tiers: unit (§8.1) and integration (§8.2). In every tier: Arrange-Act-Assert, one behaviour per test,
**synthetic data only**, and each test guards a named failure mode (a boundary, an invariant or a regression).
Write the failing test first; a bug fix starts with a test that reproduces it.

**.NET naming and libraries.** xUnit; FluentAssertions for every assertion (never xUnit's `Assert.*`); FakeItEasy for
test doubles in the unit tier only. The test class is `{ClassUnderTest}Tests` and each test
`{FunctionBeingTested}_Should{ExpectedResult}_When{Condition}`, for example
`GetOrder_ShouldReturnNotFound_WhenOrderDoesNotExist`; `.editorconfig` allows the underscores under `src/tests/`
only. Code that waits on a timer, delay or backoff is driven with a `FakeTimeProvider`. A test that counts a metric
builds its own `IMeterFactory` and listens only to that.

**Frontend naming and libraries.** vitest with Testing Library and `user-event`; `describe("<Component>")` with
`it("should <result> when <condition>")`, in a `*.test.tsx` beside the component; queries by role and label.

### 8.1 Unit tests

`src/tests/MarqSpec.FuturesLiquidityDashboard.UnitTests`: every external dependency faked, **no network, database
or file I/O**, deterministic and fast. Every public method and entry point is covered, including invalid
arguments, not-found, timeouts, empty results, cancellation and degraded paths. A test may boot the real host in
process (`WebApplicationFactory<Program>`) only when the property it guards exists only in the composition, such as
startup validation or where logs go. Line coverage is collected here and is informational only. The `test` stage
of the `Dockerfile` runs this tier: `docker build --target test .`.

### 8.2 Integration tests

`src/tests/MarqSpec.FuturesLiquidityDashboard.IntegrationTests`: the API hosted in process with
`WebApplicationFactory` on the synthetic feed, driven over REST and SignalR as a client would, with nothing under
test faked: routes, the hub, authentication, the read-only guard and metrics. Every test class carries a
`Deployment` trait; the classes that need nothing outside the machine run with
`dotnet test src/tests/MarqSpec.FuturesLiquidityDashboard.IntegrationTests --filter "Deployment=None"`.

- **The real disk under a seam the unit tests fake is tested here.** The file stores reach the disk only through
  `IFeedbackBudgetFiles` and `ILayoutFileSystem`, which §8.1 fakes, so their real adapters,
  `PhysicalFeedbackBudgetFiles` and `PhysicalLayoutFileSystem`, are tested in this tier, each test in its own
  directory under the system temp folder that is deleted afterwards (`IntegrationTests/TempDirectory.cs`).
- **No integration host writes into the repository's content root.** `DashboardFactory` blanks
  `Feedback:BudgetStorePath` and `Layouts:StorePath`, which keeps both stores in memory; a test that needs the disk
  sets a temp path after it, and `DashboardFactoryTests` fails if either is left set.

## 9. Repository layout

Base namespace and assembly prefix: `MarqSpec.FuturesLiquidityDashboard`. The solution is
`src/MarqSpec.FuturesLiquidityDashboard.slnx`, with the production projects beside it, the test projects under
`src/tests/`, and build-wide settings (`Directory.Build.props`, `Directory.Packages.props`, `.editorconfig`,
`global.json`) at the root. Each frontend is `src/<name>/`, lowercase, with `src/api/` (the one module that calls
the server), `src/components/`, `router.tsx`, `routes/` and `config.ts`. **Dependencies point inward**: hosts
reference libraries, never the reverse ([`ARCHITECTURE.md`](ARCHITECTURE.md) *Dependencies between projects*).

## 10. Quality checks

Run these before a change is considered done; they are the checks a build server should gate on:

- **.NET:** `dotnet format --verify-no-changes`, `dotnet build` (analyzers, warnings as errors, NuGet audit) and
  `dotnet test` on the solution.
- **Frontend:** `pnpm install --frozen-lockfile`, `pnpm lint` (oxlint, `--max-warnings 0`), `pnpm build` (`tsc -b`
  and `vite build`), `pnpm test` and `pnpm audit --prod`.
- **One version:** `bash scripts/check-versions.sh` (§14).
- **Scripts:** the `scripts/tests/*.test.sh` suites, run with `bash`.

## 11. Security

- **Least reach.** No entry point exposes a general file, shell, SQL or HTTP capability; every call is authorized
  against the caller's grants on the server. The API runs as the image's non-root user and reaches out only to the
  TopstepX gateway. Its one standing privilege is the ProjectX credential, which may carry trading rights; hence the
  read-only guarantee (FR-6, T-1).
- **Arguments are untrusted:** validate, parse into typed values, and never build a query, path or command by
  concatenation.
- **Stored content is data, never instructions:** an overlay's rationale is plain text and rendered as text (T-3).
- **Secrets never appear** in logs, errors, results, telemetry or exception messages; redact at the boundary
  (`Api/Auth/SecretRedactor.cs`).
- **Outbound traffic is HTTPS** with certificate validation on.
- **Synthetic or demo data only** in development and test; never real account or personal data anywhere.
- The known exposures are the threat model in [`ARCHITECTURE.md`](ARCHITECTURE.md) (`T-n`).

## 12. Transport, authentication and environments

- HTTPS beyond localhost, TLS terminated at the host's front door; SignalR over WebSockets on `/hubs/market`. No
  CORS policy: the dashboard reaches the API on its own origin, through the Vite proxy locally and nginx in the
  image. Locally the API binds `localhost:5080` and compose publishes on `127.0.0.1` unless `API_BIND_ADDRESS` is
  set (T-9).
- **API keys, not OAuth** (D-16): the server holds only each key's SHA-256 and compares in constant time; the
  dashboard asks for the viewer key and keeps it in `sessionStorage` for the tab (D-30). There is no identity
  provider.
- Permissions are `permission:scope` grants on each key ([`REQUIREMENTS.md`](REQUIREMENTS.md) §2). The key's `Name`
  is the only identity data, used for saved layouts and as an overlay's publisher, never as a metric label.
- Every environment runs the same images by version. Development grants all five permissions anonymously; any
  other environment starts with no keys and no anonymous grants until you set a key's hash on the host.

## 13. Interface documentation

- The OpenAPI document is generated from the running application (`/openapi/v1.json` in Development), never written
  by hand.
- [`INTERFACES.md`](INTERFACES.md) owns the contract each side relies on; a change to an endpoint, hub method or
  payload changes it in the same commit.

## 14. Versioning (SemVer)

- **One version for the repository**, `<Version>` in `Directory.Build.props`. Every .NET project inherits it and
  none sets its own; each frontend's `package.json` `"version"` equals it. `scripts/check-versions.sh` enforces
  that, and that the committed version is a plain `X.Y.Z` with no pre-release suffix.
- **Commits follow Conventional Commits**, and the type is the bump signal: `fix:` → patch, `feat:` → minor, `!` or
  `BREAKING CHANGE:` → major.
- **The interface forces the issue.** Removing or renaming an endpoint, hub method or field, adding a required
  parameter, narrowing an accepted value, or making a read-only entry point write is breaking, and a major bump.
  Adding an endpoint, an optional parameter or a result field is minor. While the version is `0.x`, a breaking
  change may ride a minor bump.
- **Images are tagged by version**, `:X.Y.Z` with the same value in their `org.opencontainers.image.version`
  label; a commit hash is only the `revision` label. A released version is never rebuilt: bump first. Releasing
  and rolling back are in [`DEPLOYMENT.md`](DEPLOYMENT.md) §12–§13.
