# P2 B2B (IN PROGRESS, slice 1 of several)

Run the real-DB tests:
  MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit b2b-admin.integration
Pure rules: `npx jest b2b-pricing`.

## Done (slice 1: backend foundation, seller admin)
- `src/b2b/b2b-pricing.util.ts` (+ spec, 17 tests): price resolution (volume break > fixed > entry % > catalog default % > base), up to 10 price breaks, quantity rules (catalog > product order fields), payment terms (due on order / net 15-30-60 / due on fulfilment), due dates, overdue, installment balance (no overpay, voids), deposit, credit-limit check, location-over-company settings, payment-method allow-list, buyer roles (ordering vs location admin).
- Schemas (`b2b.schema.ts`): company, location, buyer (unique per store+user), application, catalog, catalog item (unique per catalog+variant). All store-scoped.
- `B2BAdminService` + `/api/b2b/:storeId/*` controller, perms `b2b.view` / `b2b.manage` (staff registry, preset version 3, web list). Companies/locations/buyers CRUD, application approve (atomic claim) / reject, catalogs + items upsert. Buyer must be a customer of the same store; approved buyers get the `b2b` customer tag. Audit via activity log. Whitelisted input only.
- 8 real-Mongo tests: tenant isolation, no mass assignment, atomic double approval, variant ownership, break/rule validation, catalog in-use guard, location guards.

## Not done yet (next slices)
1. Storefront: wholesale application endpoint + page, buyer context, B2B price/rules in cart + checkout (server recompute), PO number, quick order list / CSV, reorder, company addresses, hide prices/cart for visitors setting, theme components (P0 shared pieces), Liquid context.
2. Payment terms on orders: order due date, partial payments (installments), deposit, overdue flag, reminders (email/WhatsApp), credit-limit enforcement at checkout, per-company payment-method restriction at checkout. (Shares data with P5 Khata: no second ledger.)
3. Seller admin web pages (companies, catalogs, applications, company order list, outstanding report, CSV export), draft orders for a company.
4. Plan limits via entitlements (not added yet).
5. Returns/exchange check on B2B orders; en/ur strings; email/WhatsApp notices for application decisions.
