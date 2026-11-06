# P2 B2B (IN PROGRESS, slice 1 of several)

Run the real-DB tests:
  MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit b2b-admin.integration
Pure rules: `npx jest b2b-pricing`.

## Done (slice 1: backend foundation, seller admin)
- `src/b2b/b2b-pricing.util.ts` (+ spec, 17 tests): price resolution (volume break > fixed > entry % > catalog default % > base), up to 10 price breaks, quantity rules (catalog > product order fields), payment terms (due on order / net 15-30-60 / due on fulfilment), due dates, overdue, installment balance (no overpay, voids), deposit, credit-limit check, location-over-company settings, payment-method allow-list, buyer roles (ordering vs location admin).
- Schemas (`b2b.schema.ts`): company, location, buyer (unique per store+user), application, catalog, catalog item (unique per catalog+variant). All store-scoped.
- `B2BAdminService` + `/api/b2b/:storeId/*` controller, perms `b2b.view` / `b2b.manage` (staff registry, preset version 3, web list). Companies/locations/buyers CRUD, application approve (atomic claim) / reject, catalogs + items upsert. Buyer must be a customer of the same store; approved buyers get the `b2b` customer tag. Audit via activity log. Whitelisted input only.
- 8 real-Mongo tests: tenant isolation, no mass assignment, atomic double approval, variant ownership, break/rule validation, catalog in-use guard, location guards.

## Done (slice 2: storefront + checkout enforcement, backend only)
- `B2BContextService`: buyer context from the logged-in user (never the request): approved company + active buyer + location overrides + active catalog. Server-side `resolveLine` = availability, quantity rule, price. Visitors, retail customers, disabled buyers, suspended/pending companies, other stores = retail (null).
- `CheckoutService.createCheckout`: wholesale unit price per line, catalog availability and quantity rules (replace the retail product rule), market price rule does not stack on a wholesale price, tax-exempt company pays no item or shipping tax, `Checkout.b2b` snapshot (company, location, role, PO number from `body.poNumber`, allowed payment methods, terms, credit limit, deposit %, tax exemption).
- Payment-method restriction: `PaymentService.assertDiscountsStillValid(checkout, method)` is called at every entry (card=`stripe`, `cash_on_delivery`, `manual`, `manual_bank_transfer`, seller gateway = provider key); store credit never blocked. The allow-list uses those keys.
- Storefront endpoints (buyer JWT, store-scoped): `GET api/b2b/storefront/me`, `POST apply` (throttled, one open application, refused for existing buyers), `POST prices` (<=50 lines: server price/rule/availability for themes to display).
- 11 real-Mongo tests + 2 gate tests; existing checkout/payment specs still pass (102 in the combined run).

## Done (slice 3: payment terms, installments, credit limit, receivables, backend)
- New payment method `b2b_terms` (`POST api/payment/b2b-terms-payment`, idempotency-key protected): order placed UNPAID, fee-free direct rail, one store at a time, only for a checkout whose company has terms; honours the company allow-list (key `b2b_terms`) and the seller credit limit (open terms orders of the company converted to store currency + this order's goods+tax; cancelled/refunded owe nothing).
- `Order.b2b` (company, location, PO number, terms, due date, total, deposit, paidTotal, installments, status). Every wholesale order gets company + PO stamped (also COD / bank transfer); terms orders also get the receivable.
- Seller API (`b2b.view`/`b2b.manage`): company orders list (status / overdue filters), record installment (overpayment guard is inside the atomic update), void, outstanding report + CSV (formula-safe). Fully paid -> normal `OrdersService.markPaid` path. Deposit: a terms order cannot be shipped/delivered/completed through the status endpoint until the required deposit is recorded.
- 10 real-Mongo tests + 7 unit tests; payment/checkout specs still pass.

Known gaps in this slice: partial fulfilment (`orders/fulfil`) does not check the deposit; due-on-fulfilment due date is approximated by the order's last update once shipped; the credit-limit check ignores shipping; reminders (email/WhatsApp) not built; an order paid in full through Mark as paid by hand is not reconciled with installments.

## Not done yet (next slices)
1. Storefront UI: wholesale application page, B2B price display in themes (via the prices endpoint), PO number field at checkout, quick order list / CSV, reorder, company addresses, hide-prices-for-visitors store setting, shared theme components, Liquid context. NOT tested: the createCheckout hook itself against a real database (it is only exercised through the context service and type-checked).
2. Reminders for due/overdue invoices (email/WhatsApp), deposit check on partial fulfilment.
4. Plan limits via entitlements (not added yet).
5. Returns/exchange check on B2B orders; en/ur strings; email/WhatsApp notices for application decisions.
