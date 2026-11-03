# Local full-stack for end-to-end testing (DEV ONLY)

Nothing here is for staging or production. The dev stack uses fake secrets (`dev/.env.dev`), **no Stripe keys** and never reads the real `.env`.

| Piece | Port | Notes |
|---|---|---|
| MongoDB (replica set `rsdev`) | 27118 | db `solvexo_dev`, data in `dev/.data/` (git-ignored) |
| Redis | 6479 | no persistence |
| API | 3102 | `http://localhost:3102`, logs in `dev/.logs/api.log` |

Your normal `mongod` (27017) / `redis` (6379) / `dump.rdb` are untouched.

## Run — natively (what has been exercised; no Docker needed)
```bash
npm run dev:stack:up       # builds if dist/ is missing (DEV_REBUILD=1 forces a rebuild), starts mongo+redis+API, waits for /health/live
npm run dev:seed           # idempotent; refuses unless the DB name contains "dev" (or --force)
bash dev/smoke.sh          # curl smoke test: login (body + cookie mode), plans, device registration, PIN login, products
npm run dev:stack:down     # stop;  `bash dev/down.sh --wipe` also deletes the dev database
```
## Run — Docker (written but NOT run: Docker was not available where this was authored)
```bash
docker compose -f docker-compose.dev.yml up --build
docker compose -f docker-compose.dev.yml --profile tools run --rm seed
```

## Seeded data (`dev/.logs/seed.json` has the generated ids)
| What | Value |
|---|---|
| Owner (password account) | `owner@solvexo.dev` / `DevPass#12345` |
| Manager (employee) | `manager@solvexo.dev`, PIN `1111` |
| Cashier (employee) | `cashier@solvexo.dev`, PIN `2222` |
| Main store | **Dev Coffee** (slug `dev-coffee`), USD, 10 % tax (exclusive, applied to subtotal), 1 register ("Register 1"), **active POS plan** "Dev POS Monthly" (30 days, $19) |
| Second store | **Expired Store** — POS plan expired 5 days ago (restricted mode / "plan not active" screen) |
| Products | Dev Latte (stock 20, barcode 1000000000011) · Dev Refill (**unlimited**, …028) · Dev Croissant (**stock 2**, low-stock, …035) · Dev Beans 1kg (stock 8, $24, …042) |

Plan-expiry flow: `npm run dev:expire-plan` (main store's plan → expired 2 days ago) and `npm run dev:restore-plan` (→ +30 days). No server restart needed.

## Test hooks (all dead in production)
* **OTP / mail** — with `DEV_OTP_LOG=true` **and** `NODE_ENV!=production` the mailer does not use SMTP: every mail is appended as a JSON line to `dev/.logs/mail.log` (`{to, subject, otp, text}`). Nothing is exposed over HTTP. Read the latest code: `tail -1 dev/.logs/mail.log | jq -r .otp`.
* **Rate limits** — `DEV_DISABLE_THROTTLE=true` (also ignored in production) switches the `@Throttle` limiter off so repeated e2e runs are not blocked. The per-email OTP cooldown (60 s) and the PIN lockout are service logic and stay active.
* **Payments** — `PAYMENT_PROVIDER=manual` (the existing dev/CI no-op provider; refuses to start in production). POS-plan Stripe Checkout therefore cannot run here; plans are granted by the seed.
* `POS_ENTITLEMENT_ENFORCED=true`, `POS_LEGACY_AUTH_ALLOWED=true`, `PORTAL_ORIGINS=http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173,http://127.0.0.1:4173`.
* A foreign `Origin` is refused by the CORS layer (HTTP 500 — pre-existing behaviour for every non-whitelisted origin; browsers block it either way).

## Point the POS app at it
`pos/config/env/local.json` = `{ "APP_ENV": "dev", "API_BASE_URL": "http://localhost:3102" }`
```bash
cd pos && flutter run -d "iPhone 17 Pro" --dart-define-from-file=config/env/local.json
```
`AppEnv.validate` only rejects http / local hosts in **release** builds, so debug/profile and `integration_test` accept it. The iOS simulator shares the Mac's network, so `localhost` reaches the API (the Android emulator would need `10.0.2.2` and cleartext traffic, which `main/AndroidManifest.xml` disables — not covered here).

## Point the portal at it
`solvexo-account-web`: `VITE_API_URL=http://localhost:3102 npm run dev` (port 5173, in `PORTAL_ORIGINS`). `resolveApiUrl` allows http only for localhost/127.0.0.1 **and only when not a production build**; `vite build` is always a production build, so `vite preview` (port 4173) against this API needs `vite build --mode development`. Session cookies work because `localhost:5173` and `localhost:3102` are the same site (host-only cookie, `AUTH_COOKIE_DOMAIN` unset).
