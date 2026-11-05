# Courier module (Pakistani couriers)

Status: **implemented and mock-tested.** Nothing has been run against a real courier sandbox. Every courier mapping ships
`verified: false`; see `docs/courier-open-questions.md` for exactly what is unconfirmed.

Supported keys: `postex`, `leopards`, `tcs`, `trax`, `mnp`, `blueex`, `callcourier`, `swyft`, `daewoo_fastex`.

## What a seller gets
- Settings → Integrations: a card per **enabled** courier (credentials, sandbox/live, test connection, status, disconnect) and
  **Courier defaults** (pickup address, optional return address, default courier, default parcel weight).
- Order detail: *Book with courier* (courier, weight, pieces, destination-city check), tracking number, tracking history,
  airway-bill download, status badge, **RTO flag**, COD amount shown read-only, *Cancel booking*, *Finish booking*.
- Orders list: select orders → *Book with courier* → per-order result report → download combined airway bills / load sheet.
- Buyer: the buyer order view gains `courierTracking` (status + events only — no COD, RTO, references or labels).

## Money rules (hard)
COD money belongs to the seller. **No ledger, balance, fee, holding or payout code is touched.**
- COD sent to the courier = the order's authoritative `totalAmount` in the **store currency** (converted via `ExchangeRateService`
  when the order currency differs; PKR rounded to whole rupees). Already paid (`isPaid` / `paymentStatus: 'paid'`) = **0**.
  Part-payments recorded with *Record payment* are subtracted. Partial shipments split COD proportionally; the final shipment
  takes the remainder so the amounts sum exactly to what is owed.
- COD / remittance information coming back from a courier is stored on the booking (`cod`) and displayed only.
- RTO (returned) sets a seller-visible flag + order timeline entry + a seller notification. It does **not** change stock, refunds or money.

## Enabling a courier (owner)
1. Set `COURIER_ENABLED_PROVIDERS` (comma list, e.g. `postex,leopards`) in the backend environment and restart. Default empty = nothing visible.
2. The seller connects their own credentials in Settings → Integrations (encrypted with `INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY`,
   never returned by any API, never logged — values are redacted from every courier error).
3. A courier is bookable only when it is enabled **and** the seller's connection is `connected` (live mode additionally needs a successful *Test connection*).
4. **Verify in the courier's sandbox first** (see below). Sandbox-mode calls are always allowed; **live-mode calls are blocked** until the
   mapping's `verified` flag is flipped to `true`. For a controlled live trial without editing code set `COURIER_ALLOW_UNVERIFIED=true`.
5. Optional: `COURIER_REQUIRES_PLAN_FEATURE=true` makes booking require the `calculatedShippingRatesAllowed` plan feature
   (off by default, because label buying is available on every plan — an open product decision).

## Credential fields per courier
| Courier | Fields (catalog: `courier-catalog.ts`) | Confidence |
|---|---|---|
| PostEx | `apiToken` (sent as header `token`) | token header from brief |
| Leopards | `apiKey`, `apiPassword` (sent in the request body) | from brief |
| TCS | `username`, `password`, `costCenterCode` | **guess** |
| Trax | `apiKey` | **guess** |
| M&P | `username`, `password` | **guess** |
| BlueEx | `username`, `password`, `accountNumber` | **guess** |
| CallCourier | `username` (login id), `password` | **guess** |
| Swyft | `apiKey` | **guess** |
| Daewoo FastEx | `username`, `password` | **guess** |

## How to verify a courier in its sandbox
1. Put sandbox credentials in the seller connect form with **mode = Sandbox**; add the courier to `COURIER_ENABLED_PROVIDERS` in a non-production environment.
2. *Test connection* → fix `authHeaders` / `baseUrl` in `providers/<courier>.mapping.ts` until it succeeds.
3. Create a pickup address in Courier defaults, book a COD order and a prepaid order; confirm the courier shows the right collect amount (0 for prepaid), weight, city and reference.
4. Print the airway bill; cancel a booking; book again.
5. Let the sync job run (or call `CourierTrackingSyncService.syncDueBookings()`), confirm normalized statuses; walk one parcel to delivered and one to returned if the courier allows.
6. Correct every field/status string in the mapping file, answer the courier's section in `courier-open-questions.md`, then set `verified: true`.

## Adding a courier
1. Add the key to `COURIER_KEYS` (`couriers/courier.types.ts`) **and** `STORE_INTEGRATION_PROVIDERS` (`schemas/store-integration.schema.ts`) and `COURIER_CATALOG` (credential fields).
2. Create `providers/<key>.mapping.ts` (headed *VERIFY AGAINST OFFICIAL DOC + SANDBOX*): `baseUrl`, auth, endpoints, request/response parsing, `statusMap`, capabilities. Use `placeholderMapping()` only as a stop-gap.
3. Create `providers/<key>.provider.ts` (`extends GenericCourierProvider`, ~5 lines).
4. Register it in the `COURIER_PROVIDERS` factory in `integrations.module.ts`.
5. Add a spec that calls `runCourierContract()` (`providers/courier-contract.testkit.ts`) with that courier's wire fixtures.
6. Add the key to the web `COURIER_KEYS` (`solvexo/src/api/services/courier.ts`).

## Architecture
- `integrations/couriers/` — `courier.types.ts` (interface, normalized statuses, `canAdvanceCourierStatus`), `courier-catalog.ts` (credential fields + enablement gate),
  `courier-http.ts` (timeouts, retry with backoff for **reads only**, error mapping, per-courier circuit breaker, secret redaction),
  `generic-courier.provider.ts` + `courier-mapping.ts` (one engine, one mapping per courier), `courier.service.ts` (connection, settings, booking records, documents),
  `schemas/courier-booking.schema.ts`.
- Bookings are **never auto-retried** at HTTP level (a retried POST after a lost response could double-book).
- `OrdersService.bookCourierShipment / bulkBookCourierShipments / cancelCourierBooking / courierDocuments / courierValidateCity` reuse `prepareLabelContext`,
  `updateSellerOrderStatus` / `fulfilItems` with trusted tracking (stock, status, shipped email/WhatsApp, timeline, partial shipments). Idempotent per
  (order, sub-order, lines); a booking that reached the courier but failed to fulfil keeps its tracking (booking row + order timeline) and is resumed by calling *Book* again — without a second courier call.
  After a cancelled booking, *Book* again swaps the new tracking onto the same shipment.
- `orders/courier-tracking-sync.service.ts` — cron `*/10 * * * *` (`SchedulerService`, Redis-locked). Per booking every ≥15 min with failure back-off; batches per `trackBatchSize`;
  events deduped by hash; statuses only move forward; `delivered` runs `OrdersService.markShipmentDelivered` (the normal delivered path) **exactly once** (one-shot claim);
  courier-side cancel frees the booking for re-booking.
- Routes (all `orders.buy_shipping_label`, store-pinned for staff by `PermissionsGuard`): `GET orders/courier/options/:storeId`, `GET orders/courier/validate-city/:storeId`,
  `GET orders/courier/order/:storeId/:orderId`, `PUT orders/courier/book` + `bulk-book` (Idempotency-Key supported), `PUT orders/courier/cancel`,
  `GET orders/courier/airway-bill/:storeId?bookingIds=`, `GET orders/courier/load-sheet/:storeId?bookingIds=`.
  Connect/test/disconnect/mode reuse the existing integrations routes (type `courier`, permission `settings.payments.manage`); settings: `GET|PUT api/store/:storeId/integrations/couriers/settings`.
- Audit trail: `ActivityLogService` actions `courier_booked`, `courier_bulk_booked`, `courier_cancelled`, `courier_rto`, `courier_airway_bill_printed`, `courier_load_sheet_printed`, `integration.connect|test|disconnect`, `courier.settings_update`.
  (`writeAuditLog` is POS-only.)
- Push webhooks: `POST webhooks/couriers/:provider/:token` is a **stub returning 501** — no courier's push payload/signature is documented to us.
  To enable one: confirm its docs, set `pushWebhook: true`, verify the signature with the seller's secret, map the payload, call `CourierTrackingSyncService.applyTrackResult` (same idempotent path as the cron).

## Known limitations
- Airway bills for couriers that return per-batch PDFs are merged with `pdf-lib`; couriers that only give links return the links.
- No city-name aliasing ("Lahore Cantt" vs "Lahore"): the courier's own city list decides.
- A booking stuck in `pending` (process died between claim and courier response) blocks that order until cleaned up — outcome is unknown, so it is not auto-retried (verify with the courier first).
- Per-courier COD min/max and weight limits are not enforced.
