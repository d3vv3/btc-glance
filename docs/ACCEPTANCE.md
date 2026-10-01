# Acceptance Audit

Audit date: 2026-10-01. Fresh observations: 19:01-19:06 UTC.
Target: `/home/devve/btcpp`, `http://localhost:3104`.
Verdict: local implementation checks pass for the deployed README scope;
full objective completion is **not established**. External delivery, public
deployment, Firefox, physical-device acceptance, and scored live samples remain open.

## Scope And Evidence Rules

Requirements below come from `README.md:7-259` and the explicit trust/core-screen
requirements in `PROPOSAL.md:79-94,177-186`. The proposal labels itself exploration
with no selected direction (`PROPOSAL.md:3,218-227`); its broader requirements
cannot silently be declared satisfied or assumed to be the selected app contract.
No goal tool was called. This audit does not attest to requirements absent from
the supplied request and these repository files.

Fresh checks are recorded here from actual command/browser output. Existing
artifacts are historical evidence, with their dates and limitations preserved.
Source inspection and mocked tests establish implementation behavior, not external
delivery. Counts are timestamped observations, not permanent totals.

## Current Runtime

- `npm run typecheck`: exit 0. `npm test`: exit 0, 16 files / 140 tests passed
  at 19:01:55 UTC. Vitest emitted a non-failing config-loader compatibility warning.
- No build ran. Build ID remains
  `bitcoin-weather-282e3207-c212-493d-aad0-d7aa770ee5a8`.
  `public/sw.js` and HTTP `/sw.js` SHA-256 both equal
  `849081abe3c16d1960ee1dde9787c169269f19df1a0ecdf711a5774ffe35b698`.
  `.next/BUILD_ID` SHA-256 before/after:
  `3a1875113ce53877edd28514dd9c1064643e26b6255013f9b0afbb893dc500e6`.
- Both `btcpp-web.service` and `btcpp-worker.service` are enabled and active/running.
  Controlled persistence-test restart: 19:05:28 UTC; final PIDs 269933 / 269935.
  Before restart, `ss` identified web PID 260033 listening on `127.0.0.1:3104`;
  `/proc/260033/fd` and `/proc/260035/fd` identified the same
  `/home/devve/btcpp/data/weather.sqlite`, WAL and SHM files.
- Both services use `/home/devve/btcpp` and the same protected application
  environment file; Node v24.15.0, `NODE_ENV=production`, localhost origin,
  absolute data directory, both VAPID keys present. Contact is localhost-only.
  No key, cookie, installation identifier, endpoint, or contact value is recorded.
- Old `btcpp-worker-live` / `btcpp-web-validation` units are inactive, PID 0.
  `loginctl show-user devve --property=Linger`: `no`. Enabled user units do not
  establish unattended logout/boot availability (also disclosed in README).
- SQLite was opened directly using `better-sqlite3` with `readonly:true`,
  `fileMustExist:true`, `query_only=ON`, busy timeout, and a read transaction.
  No application database initializer, checkpoint, backup copy, or extra collector ran.
  Integrity: `ok`; foreign-key check: no violations; journal mode: WAL.
- At 19:06:12.838 UTC: 17 live markets, 707 snapshots (139 valid), 92
  installations; watches, subscriptions, outbox and deliveries all 0.
  First capture: 16:58:54.082 UTC; latest: 19:05:47.714 UTC.
  Snapshots advanced from 659 at 19:03:09.701 UTC to 707.
  Last completed live collection: 19:06:00.694 UTC. Lease unexpired, expiry
  19:07:58.312 UTC. Hourly resolution cursor 700; no persisted error keys.

## Requirement Map

| Requirement | Exact implementation / verification | Acceptance |
| --- | --- | --- |
| Next.js/React app, typed API and validation | `package.json:14-35`; `src/client/api.ts`; `src/server/router.ts:16-95`; `src/app/globals.scss` | Implemented; typecheck and 140 tests pass. Root, manifest and public APIs return 200. |
| Live Glimpse collection, hourly/daily target selection, independent worker | `src/server/glimpse.ts:3-45`; `src/server/collector.ts:13-63`; `scripts/worker.ts:8-44`; `src/components/WeatherApp.tsx:70-175,206` | Actual live collection advances. Discovery selects bounded horizons, not the entire upstream universe. |
| Validate quotes; visibly reject inconsistent data, never substitute demo | `src/lib/forecast.ts:13-40`; `src/server/store.ts:17-49`; `src/components/WeatherApp.tsx:192-224`; `tests/forecast.test.ts`, `tests/store.test.ts` | At 19:04:39 UTC, 14 active markets: 3 ready (4285, 7134, 7136), 11 invalid. Ready distributions have 500 bins and no diagnostics. Invalid quotes remain inspectable, not live distributions. |
| Exact market/close/retrieval identity, raw provenance and version | `src/server/store.ts:6-41`; `src/app/api/forecasts/snapshot/route.ts`; `tests/snapshot.test.ts`, `tests/store.test.ts` | `/api/forecasts?topicId=7134`: ready snapshot 668, capture 19:04:01.970 UTC. `/api/forecasts/snapshot?snapshotId=583`: market 7136, capture 18:58:06.358 UTC; unchanged across service restart. |
| Readable favored/central range; interactive histogram and boundary queries | `src/lib/forecast.ts:43-58`; `src/components/Histogram.tsx:12-68`; `src/components/WeatherApp.tsx:209-223`; `tests/presentation.test.ts` | Implemented above/below whole-bin queries, focus/full range, pointer and keyboard controls. Historical live UI checks: `artifacts/final-runtime-results.json`, 18:42:02-18:42:22 UTC. Fresh live render at 390/1440px: no document overflow or uncaught errors. Between-query caveat below. |
| Fresh/stale/expired/unavailable/offline/demo states | `src/server/store.ts:43-55`; `src/components/WeatherApp.tsx:18-23,176-203`; `tests/presentation.test.ts`, `tests/diagnostics.test.ts` | Fresh Chromium at 19:04:02 UTC: daily forecast Live; offline reload Cached, saving disabled at both widths. Controlled-clock stale checks are historical, explicitly labeled in `final-runtime-results.json:374-387`. |
| Installation-owned watches; secure session, exact origin and quotas | `src/app/api/session/route.ts:7-18`; `src/server/security.ts:7-29`; `src/server/router.ts:18-70`; `tests/security.test.ts`, `tests/session.test.ts`, `tests/router-audit.test.ts` | Fresh browser session and repeat POST 200; watches list 200. Cookie Secure/HttpOnly/Strict, host-only localhost, path `/`. Unauthenticated list 401; missing/null/wrong-port/cross-site/forwarded-spoof session requests 403. Firefox remains separate. |
| Create/edit/delete and persist watches across restart | `src/components/Watches.tsx:81-139`; `src/server/router.ts:43-70`; `src/server/db.ts:14-16` | Actual disabled watch created/edited through authenticated tRPC; both services restarted; same cookie saw persisted edit; deletion and absence verified at 19:05:28.627 UTC. No threshold alert or delivery was generated. |
| Durable SQLite, migrations, concurrent writer discipline, worker lease | `src/server/db.ts:6-41`; `scripts/worker.ts:13-41`; `tests/migration.test.ts`, `tests/transactions.test.ts`, `tests/push.test.ts` | Runtime integrity, shared files, advancing lease/collection, and watch restart persistence verified. Delivery retry persistence has automated coverage, no actual live delivery state available. |
| Material change, persistence interval, cooldown, stale/demo exclusions | `src/server/alerts.ts:8-45`; `src/server/collector.ts:56-58`; `tests/alerts.test.ts` | Automated behavior verified. No real threshold-triggered external notification observed. |
| VAPID configuration, registration, test, unregister, retries and expired subscriptions | `src/server/router.ts:72-93`; `src/server/push.ts:6-49`; `src/components/Watches.tsx:98-135`; `tests/push.test.ts`, `tests/security.test.ts` | Live push config enabled/key available (values withheld). Retry/404/410/ownership paths use mocked transport tests. Actual subscribe denied; real register/test/send/unregister chain remains blocked. |
| Notification click selects exact immutable forecast and own watch | `public/sw.js:117-150`; `src/components/WeatherApp.tsx:109-167,204,224`; `src/components/Watches.tsx:39-52,78-79`; `tests/service-worker.test.ts:74-107` | `artifacts/notification-flow-results.json`, 18:59:50-18:59:53 UTC: 23 checks passed with CDP-injected push and synthetic click. Real persisted snapshot/navigation worked; focus raised InvalidAccessError. Neither trusted OS click nor external delivery is established. |
| Installable production PWA, public-only offline cache, explicit update | `src/app/manifest.ts`; `src/components/PwaControls.tsx:9-58`; `public/sw.js:8-115`; `scripts/build-service-worker.mjs`; `tests/service-worker.test.ts` | Current manifest/SW 200; fresh real Chromium offline reload passed. Prior real update evidence: `final-runtime-results.json:340-373` and `final-update-{ready,complete,offline}-390.png`; that artifact used earlier build identities. Actual Android/iOS installation and OS behavior remain open. |
| Prospective history, aligned Brier evaluation, resolution evidence | `src/server/collector.ts:65-120`; `src/server/store.ts:57-72`; `src/lib/forecast.ts:61-68`; `src/app/api/forecasts/performance/route.ts:1-5`; `tests/store.test.ts:79-99`, `tests/collector.test.ts:33-55` | Actual resolutions exist, but zero eligible scored samples. Exact endpoint evidence below. No accuracy/calibration claim. |
| Single-host deployment, persistent services, TLS instructions and operator contact | `README.md:119-231`; `deploy/btcpp-{web,worker}.service.in`; `scripts/install-user-services.mjs`; `deploy/Caddyfile.example:1-8` | Local production services operational. Public HTTPS not provisioned; domain/hosting authorization/contact missing. Logout/boot availability not established without lingering or root service configuration. |
| Firefox and real Android/iOS acceptance | `README.md:243-259` | Explicit external gates, not passed by Chromium emulation, unit tests or injection. |

## Actual Resolutions And Performance

Read-only SQLite at 19:06:12 UTC: market 4280 winner 296; market 4281 winner
300. Both have saved `worker_state` raw resolution evidence. Market 4282 has
elapsed but is still unresolved. Valid snapshot counts at 19:03:09 UTC were
1 / 0 / 1 respectively; none is in the required hourly lead-time window.

HTTP 200 from `/api/forecasts/performance` at 19:06:12.918 UTC:

| Cadence | Lead / max age | Eligible | Samples | Missing snapshot | Pending resolution | Mean Brier |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| hourly | 3600s / 300s | 3 | 0 | 3 | 0 | null |
| daily | 86400s / 300s | 0 | 0 | 0 | 0 | null |

Both `samples` arrays are empty. Metric: `multiclass-brier-original-bins`,
`sum((p-y)^2), lower is better`, source `live`. Pending resolution counts only
markets with an eligible snapshot, so 0 does not mean all elapsed markets resolved.
Collection began too late for 4280's one-hour cutoff; 4281/4282 lack a valid
capture in their cutoff windows. Resolution alone cannot manufacture samples.
Keep recording and wait for valid lead-window captures and actual winners.

## Proposal Coverage Qualifiers

The exploratory proposal's broader explicit requirements are not all implemented:

- `PROPOSAL.md:84`: above/below queries exist; there is no arbitrary between-range
  query or two-boundary selection. The fixed central range is not that feature.
- `PROPOSAL.md:85,182`: activity/liquidity metadata is stored and returned by
  `src/server/glimpse.ts:4-10`, but the current Details UI does not display those
  values; subsidies are not modeled. There is no invented numeric trust score.
- `PROPOSAL.md:184`: performance supplies Brier, counts and per-sample timestamps;
  it does not report empirical range coverage, range width, or an explicit aggregate
  evaluation period. Scored-sample detail is exposed by API, not a UI report card.
- Quote conversion and equality/out-of-support/settlement-source semantics remain
  caveated (`src/lib/forecast.ts:4`), not upstream-validated calibrated probabilities.

If those proposal requirements are binding to the original goal, meaningful
internal implementation remains for the first three items. This audit cannot
declare all internal goal gates done without that scope decision. No confirmed
required code defect was found in the deployed README scope; no application code
was changed. The obsolete proposal status is evidence of scope ambiguity, not
permission to claim these omissions complete.

## Outstanding Inputs And Tools

1. Supply the intended public domain, existing hosting/server target and permission
   to configure DNS/TLS/proxy/services, plus a real operator VAPID contact. No tunnel,
   external provider signup, infrastructure purchase or spending was performed.
2. Supply an authorized browser/device with working provider subscription and
   notification permission. Prior real Chromium `PushManager.subscribe` failed
   with `Registration failed - permission denied` despite granted notification
   permission (`notification-flow-results.json:29-44`). No subscription, queued
   test or received provider notification exists in that evidence.
3. Run Firefox cookie storage/transmission and Web Push acceptance, and physical
   Android/iOS installed/offline/app-closed delivery plus trusted notification-click
   tests on public HTTPS. Obtain user/device access and record observed results.
4. Confirm whether the broader proposal items above belong to the binding goal.
   Continue live recording until eligible resolved samples exist; waiting is an
   evidence gate, not a reason to backfill forecasts or promise accuracy.

Exposed tool namespaces are `functions` (local read/glob/grep/apply_patch/bash,
webfetch, skills, vulnerability report and goal lifecycle tools) and
`multi_tool_use.parallel`. There is **no Firefox MCP**, browser MCP, physical-device
MCP, remote-device connector or hosting provisioning tool exposed. Chromium was
used through Bash and the existing `/tmp/opencode/node_modules/playwright`, in
disposable contexts; 390px is emulation, not a physical phone. No private device
profiles/configurations were inspected. No docs connector is exposed; this is the
requested local Markdown artifact. No secrets or private watch identifiers are saved.
