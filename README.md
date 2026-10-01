# Bitcoin Weather

A Next.js application displaying Bitcoin market quote-share forecasts, with
installation-owned watches and Web Push notifications. Quote shares are not
calibrated probabilities. Live upstream failures do not silently become demo data.

## Methodology

New prospective snapshots use `quote-share-v2`: each normalized share is
`raw YES / sum(all raw YES quotes)`. YES and NO must be finite and nonnegative,
but may exceed 100. Neither YES+NO pairs nor the total must sum to 100. NO is
preserved as raw evidence and is not used for likelihood. The source scale is
not assumed to be a calibrated probability denominator: normalization is relative
market quote weight, not independently validated odds.

`originalYesSum` records the raw YES total. For backward compatibility,
`normalizationFactor = 100 / originalYesSum` remains the multiplier on
`raw YES / 100`; shares are computed directly by division to avoid intermediate
underflow. A zero total, unrepresentable total (numeric overflow), or nonfinite
normalization factor produces an explicit diagnostic, not a quote-scale ceiling.
Schema, identity, outcome coverage, bin contiguity, resolution and pre-target
gates remain in force. Alerts use normalized shares in 0..1.

Frozen v1 forecasts and historical invalid snapshots remain unchanged and readable.
There is no retrospective conversion or hindsight migration. Original-bin Brier
scores use only saved pre-target normalized shares at the specified lead time;
each scored sample identifies its transformation version. Mixed historical scores
do not establish calibration or fabricate accuracy. `PROPOSAL.md` remains a
historical reference to the original investigation, not the current methodology.

## Architecture

- Next.js serves the UI, public forecast queries, authenticated watch/push tRPC
  routes, and `POST /api/session`. The server requires Node.js, not an edge runtime.
- An independent worker discovers Glimpse markets from `https://main.bpmapi.io`,
  collects bounded quote snapshots, checks resolutions, evaluates watches, and
  delivers the persisted push outbox. Starting the web server does not start it.
- Both processes share `DATA_DIR/weather.sqlite` on the same persistent local
  disk. SQLite uses WAL, foreign keys, a busy timeout, and automatic migrations.
  Installations, watches, subscriptions, delivery retries, rate limits, snapshots,
  and the worker lease survive process restarts.
- Run one web process and one worker. The worker's transactional lease prevents
  concurrent workers; heartbeat is 30 seconds and crash expiry is 120 seconds.
  This is a single-host deployment, not an ephemeral/serverless or multi-host
  database design. Do not put SQLite on network storage.

## Local Setup

Use Node.js 22.13+ and npm. `better-sqlite3` may require a native compiler toolchain
if a prebuilt binary is unavailable on your platform.

```sh
npm ci
cp .env.example .env
npm run dev -- --hostname 127.0.0.1 --port 3104
```

Open **http://localhost:3104**. In a second terminal in this directory:

```sh
npm run worker
```

`npm run collect` performs one collection/delivery cycle and exits; use it only
when the continuous worker is stopped. It shares the worker lease.

Next.js loads `.env.local` and `.env` using its normal environment precedence.
The local `.env.local` in this workspace explicitly selects port 3104 and is
ignored by version control. The worker scripts load **only `.env`**, not Next.js
`.env.local` or `.env.production`. Keep shared settings in `.env` or supply the
same environment to both services. Existing process environment takes precedence.
Restart the affected processes after environment changes.

For another local port, set `APP_ORIGIN` to that exact browser origin and use the
same port in the server command. The unconfigured non-production default is
`http://localhost:3000`; setting a Next.js port does not change `APP_ORIGIN`.

## Origin And Sessions

`APP_ORIGIN` is the exact serialized origin shown by `location.origin` in the
browser, including any non-default port. Examples:

```dotenv
# Local development or an intentional local production-build smoke test:
APP_ORIGIN=http://localhost:3104
# Public production deployment (replace with your real domain):
APP_ORIGIN=https://weather.example.com
```

Use one value, with no trailing slash, path, credentials, query, or fragment.
Production (`NODE_ENV=production`) requires an explicit value. Public origins
must use HTTPS. HTTP is allowed only for the literal hostname `localhost`, not
`127.0.0.1`, `[::1]`, a LAN IP, custom hostname, or `localhost.*`.

Session creation and authenticated mutations require the request `Origin` to
match `APP_ORIGIN` exactly and reject `Sec-Fetch-Site: cross-site`. Missing or
`null` origins are rejected. Neither `Host`, `Forwarded`, nor `X-Forwarded-*`
authorizes an origin; a reverse proxy's internal HTTP address is not APP_ORIGIN.

The session cookie is `__Host-bw_installation`, with `Secure`, `HttpOnly`,
`SameSite=Strict`, `Path=/`, no Domain, and a one-year lifetime. Only its SHA-256
digest is stored. Keep `Secure` enabled locally: browsers support the localhost
Secure-cookie exception. Browser-specific localhost behavior still needs Firefox
verification. Cookie possession identifies an installation; this is not a user
account or cross-device login. Clearing site data loses access to its watches.
Cookies are host-scoped, not port-scoped; use a dedicated localhost test profile
when running multiple installations on different ports.

A `403` from `/api/session` with a same-origin browser request usually means the
configured origin and browser URL differ. For example, port 3104 fails against
an origin set to 3000 or 3100. Correct configuration and restart the server;
do not remove the origin check or disable Secure cookies. A `200` session response
followed by `401` from `watches.list` requires checking browser cookie storage and
the outgoing Cookie header. `429` indicates the persisted session/mutation limit.

## Environment And Push

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact browser origin; explicit in production. |
| `DATA_DIR` | Persistent directory shared by web and worker; default `./data`, resolved relative to the working directory. Use an absolute path in production. |
| `COLLECT_INTERVAL_SECONDS` | Minimum 60, default 60; cycle start interval, bounded by cycle duration. |
| `STALE_SECONDS` | Minimum 60, default 300; freshness and delivery expiry cutoff. |
| `DEMO_MODE` | Default `false`; `true` creates labeled illustrative fixtures, excluded from live scoring/notifications. Use a separate data directory for demo runs. |
| `VAPID_PUBLIC_KEY` | Public Web Push application-server key, exposed by the push configuration API. |
| `VAPID_PRIVATE_KEY` | Private signing key; keep server-side and out of logs, git, and browser bundles. |
| `VAPID_SUBJECT` | Real operator contact, e.g. `mailto:ops@example.com`; replace the example default. |

Generate a key pair once using the already installed `web-push` package CLI:

```sh
npx --no-install web-push generate-vapid-keys --json
```

Place `publicKey` in `VAPID_PUBLIC_KEY` and `privateKey` in `VAPID_PRIVATE_KEY`
in the protected environment shared by web and worker. Do not publish the output.
Keep the pair stable across deployments; changing it requires browser
resubscription. Without both keys, push configuration reports disabled and the
worker does not send notifications. Public HTTPS and notification permission are
required on real devices. iOS/iPadOS Web Push requires a supported OS version and
an installed Home Screen app; permission must follow a user interaction.

## Single-Server Deployment

1. Install dependencies with `npm ci` in an application directory such as
   `/srv/bitcoin-weather`. Create a persistent data directory such as
   `/var/lib/bitcoin-weather`, owned by the dedicated service user.
2. Configure `NODE_ENV=production`, the exact public HTTPS `APP_ORIGIN`, an
   absolute `DATA_DIR`, `DEMO_MODE=false`, and the VAPID pair/contact. Supply the
   same protected environment file to both services. Remove deployment copies
   of local overrides or explicitly override them with the service environment.
3. Run `npm run typecheck`, `npm test`, and `npm run build`. Supply the production
   environment during build as well as runtime. A build does not start the worker.
4. Supervise web and worker separately with systemd (or equivalent), a common
   working directory and user, automatic restart, and graceful SIGTERM shutdown.
5. Terminate TLS at a reverse proxy on this same host. Expose HTTPS publicly and
   bind Next.js to loopback. Allow outbound HTTPS to the upstream and supported
   push providers. Do not expose the Node port or SQLite files publicly.

### Persistent User Services

The repository ships `deploy/btcpp-web.service.in` and
`deploy/btcpp-worker.service.in`, plus a renderer that defaults to dry-run:

```sh
node scripts/init-vapid.mjs
node scripts/install-user-services.mjs --dry-run
node scripts/install-user-services.mjs --install --node /absolute/path/to/node
systemctl --user daemon-reload
```

The renderer accepts `--env`, `--data-dir`, `--port`, and `--path`. Both units
use the same protected environment file and absolute SQLite data directory.
If that file sets `DATA_DIR`, pass the same resolved directory to `--data-dir`;
the renderer rejects conflicting settings and non-production `NODE_ENV`.
Node is invoked directly, with no npm wrapper or dependency on a login shell.
Use Node 22.13+ with native dependencies installed for that Node version.
The helper only writes the two btcpp unit files; it never stops processes or
sweeps ports. Review existing units and the listener before starting:

```sh
systemctl --user status btcpp-worker-live btcpp-web-validation
ss -ltnp '( sport = :3104 )'
# Only when these are confirmed to be this application's transient units:
systemctl --user stop btcpp-worker-live btcpp-web-validation
systemctl --user enable --now btcpp-web btcpp-worker
systemctl --user status btcpp-web btcpp-worker
```

Stop the old worker fully before starting the replacement. SIGTERM aborts its
requests and releases its database lease; after a crash, allow 120 seconds for
expiry. Units restart on failure and allow 45 seconds for graceful shutdown.
For later deployments, stop `btcpp-web` before rebuilding `.next`, then restart
both units. Do not run a second collector or `collect` against the live database.
User units persist across logins and start with the user's service manager.
They do not guarantee operation while logged out; this procedure does not enable
lingering or install root services.

The VAPID initializer generates a stable pair only if both keys are absent,
preserves existing settings, refuses an incomplete pair, and never prints keys.
It atomically updates ignored `.env.local` with mode 0600. `https://localhost`
is a valid local VAPID subject; Apple's push service rejects it. Replace it with
the real operator HTTPS contact or `mailto:` address before public/iOS testing.
Localhost is a standard browser
secure context for Web Push even over HTTP, subject to browser support and
permission; public devices require HTTPS. Do not rotate keys on every restart.

`deploy/Caddyfile.example` provides an HTTPS reverse proxy example for an
already provisioned domain. Set the exact HTTPS `APP_ORIGIN` and preserve
browser Origin headers. No domain, public infrastructure, or TLS service is
provisioned by these helpers.

For a root-managed installation instead, an example service body is:

```ini
[Service]
Type=simple
User=bitcoin-weather
WorkingDirectory=/srv/bitcoin-weather
EnvironmentFile=/etc/bitcoin-weather.env
ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port 3104
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Create a second unit with the same settings and `ExecStart=/usr/bin/npm run worker`.
Use the actual installed npm/Node paths and ensure `PATH` includes Node. Protect
the environment file (mode 0600), use restricted data-directory permissions, and
enable both services on boot. On deployment, stop services before replacing the
build, then restart both. A crashed worker may need up to 120 seconds for its old
lease to expire before a replacement can acquire it.

For an already provisioned domain/server, a Caddy reverse-proxy configuration is:

```caddyfile
weather.example.com {
    reverse_proxy 127.0.0.1:3104
}
```

Set `APP_ORIGIN=https://weather.example.com`, never `http://127.0.0.1:3104`.
Preserve the browser's `Origin` header and restrict proxy virtual hosts to the
intended domain. Do not rewrite Origin to make unauthorized requests pass.
Configure HTTPS redirects, certificate renewal, and suitable request limits.
This example is configuration guidance, not a provisioned public deployment.

Back up SQLite with its online backup API, or stop both services before copying
the database (including any outstanding WAL state). Never copy only the main
SQLite file while it is being written. Verify restores and retain stable VAPID
keys. Monitor disk space, worker logs, freshness, and delivery failures; historical
snapshots have no automatic retention policy and require capacity planning.

## Checks And Acceptance

```sh
npm test -- tests/config.test.ts tests/security.test.ts tests/session.test.ts
npm run typecheck
npm test
npm run build
APP_ORIGIN=http://localhost:3104 npm run start -- --hostname 127.0.0.1 --port 3104
```

- [ ] In a clean browser context, same-origin `POST /api/session` returns 200.
  The cookie is Secure/HttpOnly/Strict/host-only; the browser sends it to
  `/api/trpc/watches.list`, which returns 200. A repeat session call reuses it.
- [ ] Missing, cross-site, wrong-port, and spoofed-forwarded-host session/mutation
  requests fail; unauthenticated watch queries return 401. Production without
  APP_ORIGIN and public HTTP origins fail configuration validation.
- [ ] Web and worker share persistent SQLite; live data becomes fresh, and
  restarts retain an installation's watches and worker delivery state.
- [ ] On public HTTPS, create/edit/delete a watch against a fresh live forecast,
  register push, and send a test notification through the running worker.
  Verify unregister, expired subscriptions, and failure/retry behavior.
- [ ] Test installed/offline behavior and push delivery on real Android and
  iOS/iPadOS devices, including notification click navigation and app-closed
  delivery. Local browser tests alone do not establish this acceptance.
- [ ] Verify Firefox session cookie storage/transmission and Web Push separately.
  No Firefox MCP tool is exposed in this agent session; real-device and Firefox
  acceptance remains manual and is not claimed by Chromium or route tests.
