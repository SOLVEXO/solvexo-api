# Solvexo app platform: developer guide (minimal)

Status: implemented + tested against a local MongoDB with direct service calls; NEVER run against a real third-party app, real browser or production. Apps are registered and approved by a Solvexo admin (no self-serve developer portal).

## 1. Get registered
A Solvexo admin registers your app (Admin -> App platform) with: name, description, **redirect addresses** (https, public domain, exact match), the **permissions** (scopes) it may ask for, optional **webhook** address + events, optional **uninstall webhook**, optional **dashboard page** (https). You receive, once: `client_id`, `client_secret`, `session_secret`. The app must be **approved** before any store can install it; suspending it removes it from every store at once.

Scopes (same as the merchant API): `read_orders write_orders read_products write_products read_customers write_customers read_inventory write_inventory` (a write scope also allows the matching read).

## 2. Install flow (OAuth-style, authorization code)
1. Send the store owner to the dashboard consent page:
   `https://seller.solvexo.store/store/<storeId>/app-platform/authorize?client_id=<id>&redirect_uri=<one of your registered addresses>&scope=read_orders read_products&state=<random string you check later>`
   (store owners can also press **Install** in Connected apps; Solvexo then uses your first redirect address and generates the state).
2. The consent screen shows your name and, in plain words, what each permission allows. The owner presses **Allow and install** (needs the `apps.manage` permission and a plan with API & webhooks).
3. The owner's browser is sent to `redirect_uri?code=<code>&state=<your state>`. **Check `state`** equals what you sent (CSRF protection). The code is single-use and valid 10 minutes, bound to your app, that exact redirect address, the store and the granted scopes.
4. From your SERVER (never the browser) call:
   `POST https://api.solvexo.store/api/app-platform/oauth/token` with JSON `{ client_id, client_secret, code, redirect_uri }`.
   Response: `{ access_token, token_type:'bearer', scope, store_id, install_id, webhook_secret }` (`webhook_secret` only when your app registered a webhook). Wrong client secret = 401; wrong/used/expired code or redirect = 400 `invalid_grant`.

Validation rules enforced by the server: the redirect address must be registered (no prefix/case/trailing-slash variants), `state` is required (1-200 chars `A-Za-z0-9_-.~:`), you can only be granted scopes you registered.

## 3. Use the API
`Authorization: Bearer <access_token>` on `https://api.solvexo.store/api/merchant/v1/...` (the same API merchants use; see Webhooks & API). The token carries only the granted scopes (403 otherwise), is limited to that one store, and is rate-limited (120 requests/min). Reinstalling replaces the old token. Uninstall, suspension or the owner removing the token makes it fail with 401 immediately.

## 4. Webhooks
If registered, each install gets its own subscription to your webhook address for your events: same payload, headers and retry schedule as merchant webhooks (`X-Solvexo-Signature: t=<unix>,v1=HMAC-SHA256(webhook_secret, "t.body")`, `X-Solvexo-Delivery` = event id for de-duplication, 5 retries, auto-disable after 15 failures). Verify the signature and reject old timestamps (5 minutes).

**Uninstall webhook:** on uninstall or suspension Solvexo sends one signed POST to your uninstall address: `{ event:'app.uninstalled', created_at, data:{ store_id, install_id, reason:'uninstalled'|'suspended' } }`, signed with the **session secret** (`X-Solvexo-Signature`). One attempt, 8 s, no redirects; delete the store's data and token on your side.

## 5. Page inside the dashboard (optional)
If you registered a dashboard page it appears in Connected apps ("Open <title>"). It is shown in a sandboxed iframe (`allow-scripts allow-forms allow-same-origin allow-popups`, `referrerPolicy=no-referrer`). Handshake (no token in the URL):
1. Your page loads and calls `window.parent.postMessage({ type: 'solvexo:ready' }, '*')`.
2. The dashboard answers ONLY your iframe on your exact origin: `postMessage({ type:'solvexo:session', token, storeId }, <your origin>)`. Ask again any time with `{ type:'solvexo:session-request' }` (tokens live 5 minutes).
3. `token` is an HS256 JWT signed with your **session secret**: claims `iss:'solvexo', aud:<client_id>, sub:<user id>, store:<storeId>, install:<install id>, iat, exp, jti`. Verify signature, `aud`, `exp` and use `store` as the store you act on; never trust a store id from anywhere else.

## 6. Limits / not built
Max 5 redirect addresses per app, 20 installed apps per store, scopes only from the list above. Not built: self-serve developer registration, per-app rate-limit plans, app billing, theme app blocks, GraphQL, app-owned data storage, refresh tokens (the access token is long-lived until uninstall/revoke), granular per-resource scopes.
