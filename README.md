# BossCall service

Standalone backend for the BossCall app. It lets the app work end-to-end
without touching the production Salon backend.

- `POST /api/bosscall/call` — queue a call for the boss (Muse)
- `GET /api/bosscall/pending` — oldest pending call, or null
- `POST /api/bosscall/reply` — answer a call (`yes` / `no` / `ok`)
- `GET /api/bosscall/replies` — answered calls, newest first
- `GET /health` — health check

Every `/api/bosscall/*` endpoint requires header `X-Boss-Key` equal to the
`BOSSCALL_KEY` environment variable. Calls live in memory only — they do
not survive a server restart.

Run locally:

```sh
npm install
BOSSCALL_KEY=<key> node server.js
```
