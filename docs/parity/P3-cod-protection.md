# P3 COD protection (IN PROGRESS, slices 1-2 of 3)

Run: `MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit cod-protection` (pure rules: `cod-risk`).

## Done (slice 1: rules, score, stamping, guard; backend)
- `src/cod-protection/`: per-store settings (off by default): max COD amount, confirm new customers / above an amount / flagged cities, blocked phones + address fragments, high-risk score, "high risk = no COD", confirmation hours. PK phone formats collapse to one key. Settings validated, audited, whitelisted.
- Score 0-100 from THIS store's history only (RTO from the courier module `rto` flag, cancelled COD orders, returns, deliveries) + rule hits; reasons listed.
- Verdict per COD order: allow / confirm / block_cod. Enforced at `codPayment` and for the COD half of a split payment; the checkout hides COD up front when the rules already refuse it. Multi-store carts take the strictest store.
- `Order.codProtection` (merchant-only, stripped from buyer views): score, level, reasons, confirmation state (`awaiting` + expiry), manual override.
- Fulfilment is refused while a COD order awaits confirmation (status change and partial fulfilment). Seller can confirm by hand (`POST api/cod-protection/:storeId/orders/:orderId/confirm`, perm `orders.edit`, audited).
- Tests: 13 pure rules + 6 real-Mongo (store isolation of history, verdicts, stamping, manual confirm); payment/checkout/orders specs still pass.

## Done (slice 2: confirmation round trip, backend)
- Signed one-time link (`cod-confirm-token.util`, purpose `cod_confirm`, carries order id, per-send id and the window end; a resend rotates the id so older links stop working). Sent on placement when the verdict is "confirm": email (catalog event `cod_confirmation`, cannot be switched off) and WhatsApp (new event `cod_confirmation`, OFF until the store has an approved template and enables it; token `confirm_url`). A failed send never fails the order; channels sent are recorded.
- Public endpoints (no login, throttled): `GET api/public/cod/:token` (store name, order number, total, item count, status only), `POST .../confirm`, `POST .../cancel`. Every change is an atomic claim on the confirmation status: double taps, replays and parallel calls act once; cancel runs the normal order cancellation (stock released) and is rolled back if it fails; after confirming, cancel is refused.
- Auto-cancel: cron every 15 min (Redis lock) claims expired `awaiting` orders and cancels them through the normal seller-cancel path (stock released, timeline, notifications); a failed cancel is retried on the next run.
- Seller: `POST api/cod-protection/:storeId/orders/:orderId/resend-confirmation` (perm `orders.edit`).
- Tests: 8 real-Mongo (real PaymentService placement -> stamp -> send, view, confirm replay, cancel once with stock released, resend rotates link, expiry + auto-cancel with restock, repeat customer not asked, failed cancel restores state) + token unit tests; whatsapp / email specs still pass.
- Known limit: WhatsApp and the email link need the storefront page `/cod-confirm/:token` (slice 3) to be useful; until then the link opens a 404 page. Do not enable for real stores before slice 3.

## Not done (slice 3)
- Slice 3: seller UI (settings page, risk badge + reasons on order detail, manual confirm button), dashboard widget (confirmation rate, RTO rate, saved amount), en/ur strings.
- "Unreachable" history signal and partial prepayment are not built (no data / needs split payments).
