# WC26 Tracker

A live FIFA World Cup 2026 tracker built on Cloudflare Workers. Pulls data from ESPN's public API (no key required), caches it in KV, and serves a single-page frontend with live scores, group standings, and the knockout bracket.

---

## Features

- **Live tab** — appears automatically when a match kicks off; big scoreboard cards with score, elapsed time, and a progress bar
- **Goal toasts** — slide-in notification with confetti burst and haptic feedback when a goal is detected
- **Kickoff / full-time toasts** — ambient notifications for match lifecycle events
- **Live score in browser tab title** — `BRA 2–1 FRA · NED 0–0 ESP | WC26`
- **Group standings** — all 12 groups, auto-sorted, with qualification highlighting
- **Knockout bracket** — full R32 → Final tree with connector lines, updates as slots are filled
- **Adaptive polling** — every 1 min during match hours; 15 min before kickoff through 15 min after estimated end; 30 min idle otherwise
- **Watch dropdown** — Crave / TSN links on live match rows (Canadian broadcast)

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Cloudflare Worker (JS) |
| Cache | Cloudflare KV |
| Data | [ESPN public API](https://www.espn.com/apis/devcenter/docs/) — no key required |
| Frontend | Vanilla HTML / CSS / JS, stored in KV |
| Deploy | [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) |

No build step. The frontend is a single `public/index.html` uploaded directly to KV.

---

## Project structure

```
├── src/
│   └── worker.js          # Cloudflare Worker — API routes + cron data fetcher
├── public/
│   └── index.html         # Entire frontend (HTML + CSS + JS, ~60 KB)
├── deploy-html.js         # Script: uploads public/index.html to KV
├── wrangler.toml          # Worker config — routes, KV binding, cron schedule
├── .dev.vars.example      # Template for local secrets
└── package.json
```

---

## Self-hosting

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- Node.js 18+
- `npm install` (installs Wrangler)

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/wc26-tracker.git
cd wc26-tracker
npm install
```

### 2. Authenticate Wrangler

```bash
npx wrangler login
```

### 3. Create a KV namespace

```bash
npx wrangler kv:namespace create WC26_KV
# Also create a preview namespace for local dev:
npx wrangler kv:namespace create WC26_KV --preview
```

Copy the `id` and `preview_id` values into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "WC26_KV"
id = "YOUR_KV_NAMESPACE_ID"
preview_id = "YOUR_KV_PREVIEW_NAMESPACE_ID"
```

### 4. Configure your domain (optional)

By default the Worker deploys to `wc26-tracker.YOUR_SUBDOMAIN.workers.dev`. To use a custom domain, update the routes in `wrangler.toml`:

```toml
routes = [
  { pattern = "your-domain.com", custom_domain = true }
]
```

Or remove the `routes` block entirely to use the default `*.workers.dev` URL.

### 5. Set the refresh secret

This protects the `/api/refresh` endpoint from public abuse.

```bash
# Set the secret in Cloudflare (production)
npx wrangler secret put REFRESH_SECRET

# Set it locally for dev
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set REFRESH_SECRET to any random string
# Generate one with: openssl rand -hex 32
```

### 6. Deploy the Worker

```bash
npm run deploy
# or: npx wrangler deploy
```

### 7. Upload the frontend HTML

The frontend is stored as a KV value (key: `html`) rather than bundled with the Worker, so it can be updated independently without redeploying the Worker.

```bash
npm run deploy:html
# or: node deploy-html.js
```

### 8. Seed initial data

Trigger the first data fetch manually — the cron won't fire until the next scheduled interval:

```bash
curl -X GET https://YOUR_WORKER_DOMAIN/api/refresh \
  -H 'x-refresh-secret: YOUR_SECRET'
```

Your tracker should now be live at your Worker URL.

---

## Deploying updates

| Changed | Command |
|---|---|
| `src/worker.js` (backend logic, cron) | `npm run deploy` |
| `public/index.html` (frontend) | `npm run deploy:html` |
| Both | `npm run deploy:all` |

---

## Local development

```bash
npm run dev
# Wrangler starts a local dev server at http://localhost:8787
# Uses .dev.vars for secrets and the preview KV namespace
```

The cron won't fire locally — trigger a refresh manually:

```bash
curl http://localhost:8787/api/refresh -H 'x-refresh-secret: your-local-secret'
```

---

## API routes

| Route | Description |
|---|---|
| `GET /` | Frontend HTML (served from KV) |
| `GET /api/standings` | Group standings + qualified bracket slots (JSON) |
| `GET /api/matches` | Full match list with live scores (JSON) |
| `GET /api/refresh` | Force a data refresh — requires `x-refresh-secret` header |
| `GET /icon.png` | App icon (stored in KV) |

---

## Cron schedule

```toml
"* 14-23,0-4 * * *"   # every minute during match hours (UTC)
"0 5-13/2 * * *"      # every 2 hours overnight (heartbeat)
```

The Worker is adaptive — it only hits ESPN when something is actually happening:

- Match is live → fetch scoreboard every cron tick
- 15 min before kickoff or up to 15 min after estimated end → same
- Otherwise → fetch at most every 30 min

---

## Environment variables

| Variable | Where | Description |
|---|---|---|
| `REFRESH_SECRET` | `.dev.vars` / Wrangler secret | Protects `/api/refresh` |

No ESPN API key is required — the data endpoints used are public.

<!-- ntfy workflow smoke test — safe to delete this branch/PR -->
