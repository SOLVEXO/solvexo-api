# Store Integrations API — reference for Seller Web / mobile teams

Covers the payment-gateway (Safepay live; Stripe via existing Connect; JazzCash/Easypaisa/PayFast interface-ready but not yet implemented) and WhatsApp Business integration module. All endpoints require a bearer token (`Authorization: Bearer <token>`) unless noted.

## Field safety — read this first

- **Never returned by any endpoint, ever**: raw API keys/secrets, WhatsApp access tokens, webhook signing secrets — `credentialsEncrypted` is never serialized in any response.
- **Safe to display to a seller**: everything in a listing's `maskedHints` object (last 4 characters only, e.g. `"secretKey": "••••90ab"`), `status`, `mode`, `isEnabledForCheckout`, `lastVerifiedAt`, `lastError`, `config.displayName`.
- **Safe to display to a buyer at checkout**: only the shape returned by `GET /api/checkout/:checkoutId/payment-methods` — `provider`, `displayName`, `currency`, `logo`. Nothing else about a store's integrations is ever exposed on the buyer side.

## Seller-facing — manage a store's integrations

Base path: `api/store/:storeId/integrations`. Requires seller JWT (`role: seller`) whose account owns `:storeId` — enforced server-side, never trust a `storeId` you didn't get back from an authenticated call.

### `GET /api/store/:storeId/integrations`

Lists every available provider for the store's own currency (`Store.baseCurrency`: `PKR` stores see Safepay/JazzCash/Easypaisa/PayFast — currently only Safepay is actually connectable; `USD` stores see Stripe only) plus WhatsApp.

```jsonc
{
  "success": true,
  "data": {
    "payment": [
      {
        "id": "665f...",                 // null if never connected
        "type": "payment",
        "provider": "safepay",
        "mode": "sandbox",               // "sandbox" | "live"
        "status": "connected",           // "not_connected" | "connected" | "disabled" | "error" | "needs_reauth"
        "isEnabledForCheckout": true,
        "lastVerifiedAt": "2026-08-20T10:00:00.000Z",
        "lastError": null,
        "config": { "displayName": "Safepay", "currency": "PKR" },
        "maskedHints": { "secretKey": "••••90ab", "clientId": "••••1234", "webhookSecret": "••••ef01" }
      },
      { "id": null, "provider": "stripe", "status": "not_connected", "manageVia": { "statusUrl": "/api/stripe-connect/status", "connectUrl": "/api/stripe-connect/onboarding-link" }, "...": "..." }
    ],
    "whatsapp": { "id": null, "provider": "whatsapp_cloud", "status": "not_connected", "...": "..." }
  }
}
```

Stripe never appears with a real `id` — it's read live from the existing `/api/stripe-connect/*` endpoints; use `manageVia` to send the seller there to connect/manage it, not this module.

### `POST /api/store/:storeId/integrations/:type/:provider/connect`

**Safepay** (`type: payment`, `provider: safepay`):
```json
{ "secretKey": "sk_test_...", "clientId": "...", "webhookSecret": "...", "displayName": "Safepay" }
```
`mode` is auto-detected from whether `secretKey` contains `_live_`.

**WhatsApp** (`type: whatsapp`, `provider: whatsapp_cloud`):
```json
{ "code": "<Embedded Signup exchangeable code>", "phoneNumberId": "1234567890", "businessId": "optional", "displayName": "optional" }
```
`code` and `phoneNumberId` come from Meta's own Embedded Signup JS SDK callback on the frontend — specifically the `WA_EMBEDDED_SIGNUP` postMessage event, which carries `phone_number_id`/`waba_id`/`business_id` separately from the `code`. **Do not send `wabaId`** — the backend now derives it itself from Meta's own API using the exchanged token (a Phase 8 security fix; a client-supplied `wabaId` would have been trusted blindly before that). The backend verifies the exchanged token actually has access to the given `phoneNumberId` before accepting the connection, and rejects it if another store has already claimed that number.

**Stripe**: not supported here — returns 400 pointing at the existing `POST /api/stripe-connect/onboarding-link`.

Response: `{ success: true, data: <same shape as one list entry> }`.

### `POST /api/store/:storeId/integrations/:id/test`

No body. Re-verifies stored credentials (WhatsApp: a live Meta `debug_token` check; payment gateways: confirms the stored credentials decrypt correctly — **not** a live sandbox transaction). Sets `lastVerifiedAt` on success, `status: 'error'` + `lastError` on failure.

```json
{ "success": true, "data": { "ok": true, "message": "WhatsApp access token is valid" } }
```

### `PATCH /api/store/:storeId/integrations/:id`

```json
{ "isEnabledForCheckout": true, "displayName": "My gateway" }
```
Refuses to set `isEnabledForCheckout: true` on a `mode: 'live'` integration unless a `test` call has already succeeded (`lastVerifiedAt` is set) — run `/test` first.

### `DELETE /api/store/:storeId/integrations/:id`

No body. Wipes the stored credential and reverts to `not_connected` (the row itself is kept for audit history, not hard-deleted).

## Buyer-facing — checkout

Base path: `api/checkout/:checkoutId/payment-methods`. Requires buyer JWT (`role: user`) owning that checkout. `:checkoutId` is the id from the existing checkout-creation flow — **not** a store id; the store is resolved server-side from the checkout's own line items.

### `GET /api/checkout/:checkoutId/payment-methods`

```json
{ "success": true, "data": [ { "provider": "safepay", "displayName": "Safepay", "currency": "PKR" } ] }
```
Returns `[]` for a checkout whose items span more than one store — those keep using the existing COD/manual-transfer/platform-Stripe checkout path, unaffected by this module.

### `POST /api/checkout/:checkoutId/payment-methods/:provider/initiate`

```json
{ "returnUrl": "https://yourapp.example/checkout/<id>/return", "cancelUrl": "https://yourapp.example/checkout/<id>/cancel" }
```
Both are required — there's no platform-wide default to fall back to. Response shape depends on the provider:
```jsonc
// Safepay (redirect-based)
{ "success": true, "data": { "redirectUrl": "https://sandbox.api.getsafepay.com/embedded/?...", "sessionId": "track_..." } }
// Stripe (client-confirmed, no redirect)
{ "success": true, "data": { "clientToken": "pi_..._secret_...", "sessionId": "pi_..." } }
```
Supports an `Idempotency-Key` header — same interceptor the rest of checkout already uses, so a retried tap never opens two payment sessions.

## Webhooks (not called by any frontend — gateway/Meta configuration only)

- Payments: `POST /webhooks/payments/:provider/:webhookToken` — one unique URL per connected integration, shown nowhere in the API; configure it in the gateway's own dashboard when connecting.
- WhatsApp: `GET`/`POST /webhooks/whatsapp` — one shared URL for the whole platform, configured once in the Meta App dashboard.

## Env vars this module needs (not yet set — add before going live)

`INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY`, `META_APP_ID`, `META_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
