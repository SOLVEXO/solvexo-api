# Shopify-parity batch — progress (resume file)
Work directly on `uzair-branch` (both repos). Never main, never push. Do not commit local-only files (jest.unit.config.js).
Run unit tests: `npx jest -c jest.unit.config.js <path>` (repo jest config needs mongodb-memory-server, not installed here).

- [x] TASK 0 courier cleanup — `npm run build` exit 0; docs line fixed. Broader regression was started but stopped before completion (see report).
- [~] TASK 1 customer segments — DONE: backend module (filter util + 46 tests, service, controller, CRUD/preview/members/export/duplicate), Customers list `segmentId`, email-campaign `segmentId`, automatic-discount `customerSegmentId` (checkout eligibility at redeem time), web UI (SegmentsBar/builder/SegmentSelect, en+ur). NOT DONE: product_purchased picker in UI (API supports ids), coupon (code) segment eligibility, no browser/Mongo run of the aggregation.
- [ ] TASK 2 bundles
- [ ] TASK 3 pre-order
- [ ] TASK 4 upsell / cross-sell
