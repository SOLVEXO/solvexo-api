# Courier module — progress (resume file)

Branch: `feature/courier-integration` (both repos: `solvexo-api`, `solvexo`), branched from `uzair-branch`. Never commit to main.
Run unit tests with the local, uncommitted `jest.unit.config.js` (the repo's own jest config needs `mongodb-memory-server`, which is not installed in this sandbox):
`npx jest -c jest.unit.config.js <path>`.

## Phases
- [x] Phase 1 — backend foundation (types, interface, registry, catalog + enablement gate, shared HTTP helper, schema enums)
- [x] Phase 2 — 9 provider adapters + mapping files + mocked-HTTP tests (all mappings verified:false; live blocked until verified, sandbox allowed)
- [x] Phase 3 — booking flow: CourierService, CourierBooking schema, Store.courierSettings, OrdersService.bookCourierShipment/bulk/cancel/docs, controller routes (orders.buy_shipping_label), connect/test/list in integrations. Service tests are in Phase 6.
- [x] Phase 4 — CourierTrackingSyncService (cron every 10 min via SchedulerService), events, delivered-once, RTO flag+notify only, COD read-only, buyer-safe courierTracking on buyer order views, push webhook STUBBED (501). Sync tests done (11).
- [x] Phase 5 — frontend (solvexo repo): Integrations courier cards + defaults, order-detail CourierBookingsCard, BookCourierModal, BulkCourierModal, en+ur strings, 8 component tests. Backend added GET orders/courier/validate-city.
- [ ] Phase 6 — service tests, docs/courier-module.md, final audit

## Decisions
- All code under `src/integrations/couriers/`. Adapters = `GenericCourierProvider` + one mapping file each.
- Audit logging uses `ActivityLogService.log` (what orders/integrations already use); `writeAuditLog` is POS-only.
- Permission reused: `orders.buy_shipping_label` (book/cancel/label/load sheet); connect/settings ride the existing integrations controller (`settings.payments.manage`).
- Bookings are never auto-retried at HTTP level (double-booking risk); reads retry.
