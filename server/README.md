# Regatta Assistent sea routing backend

This folder contains the server-side sea routing API for the Regatta Assistent PWA.

## Why this exists

GitHub Pages can only serve static files. The PWA should not guess safe boat routes in the browser. The backend computes sea routes from a water mask/coastline dataset and returns route points that the PWA can follow.

## Endpoints

- `GET /health`
- `GET /route?from=59.2015,10.7663&to=59.193,10.792&clearance=25&grid=45&margin=1200`

Response:

```json
{
  "ok": true,
  "route": [[59.20,10.76],[59.19,10.77]],
  "source": "watermask-theta-star",
  "clearance": 25,
  "grid": 45,
  "nodes": 130
}
```

## Local run

```bash
npm run route-api
curl 'http://127.0.0.1:8787/health'
curl 'http://127.0.0.1:8787/route?from=59.2165,10.7705&to=59.193,10.792&clearance=25&grid=45&margin=1200'
```

## Connect the PWA to an API deployment

Once deployed, open the app with:

```text
https://strayeai.github.io/regatta-assistent/?v=2026-05-02-pwa14&routeApi=https://YOUR-ROUTE-API.example.com
```

The app stores `routeApi` in `localStorage.regattaRouteApiUrl` so future opens reuse it.

If `routeApi` is configured, the demo boat waits for the server route and does not fall back to the old client-side guess while the API is calculating.

## Current data source

`server/data/coastline-hanko.json` contains OpenStreetMap coastline ways for the Hankø area, fetched via Overpass during development. This is a watermask/coastline approach; for production-grade navigation, replace or supplement it with nautical chart data (S-57/S-101/ENC) including depth/no-go zones.
