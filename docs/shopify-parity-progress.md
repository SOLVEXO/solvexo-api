# Shopify-parity batch — progress (resume file)
Work directly on `uzair-branch` (both repos). Never main, never push. Do not commit local-only files (jest.unit.config.js).
Run unit tests: `npx jest -c jest.unit.config.js <path>` (repo jest config needs mongodb-memory-server, not installed here).

- [x] TASK 0 courier cleanup — `npm run build` exit 0; docs line fixed. Broader regression was started but stopped before completion (see report).
- [~] TASK 1 customer segments — DONE: backend module (filter util + 46 tests, service, controller, CRUD/preview/members/export/duplicate), Customers list `segmentId`, email-campaign `segmentId`, automatic-discount `customerSegmentId` (checkout eligibility at redeem time), web UI (SegmentsBar/builder/SegmentSelect, en+ur). NOT DONE: product_purchased picker in UI (API supports ids), coupon (code) segment eligibility, no browser/Mongo run of the aggregation.
- [x] TASK 2 bundles (backend + tests; UI see below)
- [x] TASK 3 pre-order (backend + tests)
- [x] TASK 4 upsell / recommendations (backend + tests)

## Status after Tasks 2-4 (backend + web committed)
NOT done / partial: bundle in draft orders + POS; bundle weight = sum of components; packing-slip/order-document component lines; order-list "Pre-orders" filter; pre-order wording in buyer confirmation email/WhatsApp; Liquid theme context + storefront theme rendering of bundle/pre-order/upsell (public API exposes `bundle`, variant `preorder`, `api/public/merchandising/*`); recommendations cache; bundle component picker uses each product's default variant (API supports any variant). Concurrency/no-oversell relies on the existing atomic reserve + new atomic pre-order $inc (not run against real MongoDB).

## Follow-up pass (done): bundle weight = sum of components, buyer email pre-order/bundle text, order-list Pre-orders filter, storefront (Maison): variant pre-order label/availability + bundle "includes" list + cart upsell block, packing-slip/invoice component + pre-order lines, segment product-purchased picker.
Still NOT done: bundles in draft orders/POS; coupon-code segment eligibility; recommendations cache; storefront cart/checkout pre-order notice and product-page recommendations rail for non-Maison themes; Liquid theme context; inventory-page reserved pre-order panel; no concurrency/browser/real-DB runs.

## Final pass (done): bundles in draft orders + POS (stock expansion; POS uses the bundle's CURRENT components, no per-sale snapshot), coupon-code segment eligibility (checked at redeem), public recommendations cache (30s TTL, invalidated on writes), cart pre-order/bundle notice + checkout summary note, Liquid product context (`variants[].preorder`, `product.bundle`, derived availability), inventory Pre-orders tab, coupon segment picker.
Still not done: other (non-Maison) storefront themes render nothing new (Maison + Liquid only); no concurrency/real-DB/browser/real-order run; POS/draft bundle paths have no dedicated tests.
