# Courier module — open questions (things NOT verified)

Nothing in this module has been run against a real courier sandbox. Every mapping file
(`src/integrations/couriers/providers/*.mapping.ts`) is headed **VERIFY AGAINST OFFICIAL DOC + SANDBOX** and ships with
`verified: false`; live-mode calls are blocked until it is flipped (sandbox-mode calls are allowed — that is how you verify).

## PostEx
- Exact paths/versions recalled (`/order/v3/create-order`, `/order/v2/get-operational-city`, `/order/v1/cancel-order`, `/order/v1/track-bulk-order`, `/order/v1/get-invoice`, `/order/v1/generate-load-sheet`) — confirm each in sandbox. The official PDF differs from the live API; sandbox wins.
- Create-order body field names (`orderRefNumber`, `invoicePayment` as string, `invoiceDivision`, `pickupAddressCode`, `cityName`…), and whether `storeAddressCode` is also required.
- Response envelope (`statusCode`/`statusMessage`/`dist`) and the exact `transactionStatusMessage` vocabulary (the status map is a recalled list).
- Load-sheet request body (courier name? pickup address?) and whether it returns a PDF or a JSON URL.
- Whether `get-invoice` returns PDF bytes or a URL; max 10 tracking numbers per call assumed from the brief.
- Is there a sandbox host, or is sandbox just a test token on the same host?
- Merchant address registration (`create-merchant-address`): not implemented — sellers enter their PostEx pickup **address code** in courier settings.
- COD/remittance status endpoint: not implemented (capability `codStatus: false`).
- Push webhook: none documented → stubbed.

## Leopards
- Host names (`merchantapi.leopardscourier.com` live / `merchantapistaging.leopardscourier.com` test) and the `/format/json/` path suffix.
- Body field names for `bookPacket`; whether weight is grams (assumed) and whether `origin_city`/`destination_city` need numeric ids from `getAllCities` (assumed yes; `self` used for origin when none saved).
- `status`/`error` response envelope, `track_number`, `slip_link`; cancel call name/body (`cancelBookedPackets` / `cn_numbers` assumed).
- Tracking response shape (`packet_list`, `Tracking Detail`) and status wording.
- Airway bill: `slip_link` returned at booking is saved as the label URL; no separate airway-bill call implemented.

## TCS, Trax, M&P, BlueEx, CallCourier, Swyft, Daewoo FastEx
No documentation available. For each: base URLs (sandbox + live), auth scheme (credentials fields in `courier-catalog.ts` are guesses),
create/track/cancel/label endpoints and field names, city-list availability, status vocabulary, COD fields, load sheet, push webhook.
The shared placeholder wire format in `placeholder-mapping.ts` is generic and NOT courier-confirmed. Hosts are `*.invalid` so an accidental live call cannot reach anything.

## Cross-cutting
- Whether any courier needs the destination `cityId` (numeric) rather than a name — Leopards assumed yes; resolved via the courier's city list at booking.
- Per-courier COD maximum / minimum amounts and weight limits (not enforced).
- Whether entitlements should plan-gate courier booking (see `docs/courier-module.md`, "Plan gating").
