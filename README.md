# BTC glance

<p align="center">
    <img src="public/icons/sun-orb-preview-512.png" alt="BTC glance" width="128"/>
    <br/>
    <b>A Bitcoin weather forecast, powered by prediction markets.</b>
</p>

BTC glance turns Glimpse prediction-market quotes into a visual outlook for
Bitcoin. Explore hourly and daily price ranges, see bullish, bearish, or mixed
conditions, and compare recorded forecasts with actual Kraken prices. Save
market quote-weight alerts and follow the outlook in a mobile-friendly,
installable PWA.

## Features

- Hourly and daily outlooks with price ranges, heatmaps, and weather indicators.
- Bullish, bearish, or mixed conditions based on market quote weight relative to the latest observed close.
- Interactive distributions for exploring price brackets and above/below thresholds.
- Recorded forecast history alongside actual Kraken BTCUSD closes.
- Saved quote-weight watches, Web Push alerts, and an installable mobile PWA with offline viewing.

## How It Works

Glimpse supplies the prediction markets and their YES quotes. Each price bracket's
relative weight is `YES / sum(all YES quotes)`: these are relative market quote
weights, not calibrated probabilities or a guarantee of future prices.

Historical forecasts use snapshots recorded before their target time, never
reconstructed from known outcomes. Kraken supplies observed BTCUSD closes for
comparison, not Glimpse's exact settlement prices. Missing or stale data remains
visible rather than being silently replaced with demo forecasts.

## Tech Stack

Next.js, React, TypeScript, tRPC, SCSS, SQLite, and Web Push. An independent
worker collects market quotes and observed prices, records forecasts, and
evaluates alerts; it shares persistent SQLite storage with the web app.

## Getting Started

Use Node.js 24 and npm:

```sh
npm ci --ignore-scripts=false
cp .env.example .env
npm run dev
```

Configure `.env` with `APP_ORIGIN=http://localhost:3000` and shared data settings.
Set VAPID keys and an operator contact to enable Web Push. In a second terminal:

```sh
npm run worker
```

Open http://localhost:3000. Run only one worker against the shared database.

## Docker Deployment

On the target host, place the checkout at `/opt/services/glance` and provision
the ignored `.env` (mode 0600) with the real VAPID keys and any collection settings. Compose
loads `.env` explicitly; `.env.example` is only a template. The external `traefik`
network must already exist, with the `websecure` entrypoint and `le` certificate
resolver. No host ports are published; HTTPS serves `glance.devve.space`.

Both services use one locally built Node.js 24 image, run as `node` (UID 1000),
and share the persistent `glance_data` volume. Initialize its ownership before
first startup, including after a future database import. Back up the volume
before importing data and stop both services during import. The worker waits
for the web app's database-initializing health check and must not be scaled.
The image retains dev dependencies because the worker runs through `tsx`;
environment files, tests, and local data are not copied into the image.

```sh
cd /opt/services/glance
docker compose build web
docker volume create glance_data
docker run --rm --user root --mount type=volume,src=glance_data,dst=/app/data btc-glance:local chown -R node:node /app/data
docker compose up -d --build
```
