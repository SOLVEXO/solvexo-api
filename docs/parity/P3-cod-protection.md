# P3 COD protection (IN PROGRESS, slice 1 of 3)

Run: `MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit cod-protection` (pure rules: `cod-risk`).

## Done (slice 1: rules, score, stamping, guard; backend)
- `src/cod-protection/`: per-store settings (off by default): max COD amount, confirm new customers / above an amount / flagged cities, blocked phones + address fragments, high-risk score, "high risk = no COD", confirmation hours. PK phone formats collapse to one key. Settings validated, audited, whitelisted.
- Score 0-100 from THIS store's history only (RTO from the courier module `rto` flag, cancelled COD orders, returns, deliveries) + rule hits; reasons listed.
- Verdict per COD order: allow / confirm / block_cod. Enforced at `codPayment` and for the COD half of a split payment; the checkout hides COD up front when the rules already refuse it. Multi-store carts take the strictest store.
- `Order.codProtection` (merchant-only, stripped from buyer views): score, level, reasons, confirmation state (`awaiting` + expiry), manual override.
- Fulfilment is refused while a COD order awaits confirmation (status change and partial fulfilment). Seller can confirm by hand (`POST api/cod-protection/:storeId/orders/:orderId/confirm`, perm `orders.edit`, audited).
- Tests: 13 pure rules + 6 real-Mongo (store isolation of history, verdicts, stamping, manual confirm); payment/checkout/orders specs still pass.

## Not done (slices 2-3)
- Slice 2: confirmation message (email event + WhatsApp, signed one-time link, public confirm/cancel endpoints), auto-cancel cron with correct restock, token expiry/replay.
- Slice 3: seller UI (settings page, risk badge + reasons on order detail, manual confirm button), dashboard widget (confirmation rate, RTO rate, saved amount), en/ur strings.
- "Unreachable" history signal and partial prepayment are not built (no data / needs split payments).
