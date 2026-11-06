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

## Done (slice 4: seller web UI)
- Seller sidebar > Orders > **Wholesale** (`/store/:id/wholesale`, perms `b2b.view`/`b2b.manage`): Companies (list, add/edit incl. terms, credit limit, deposit %, tax exempt, allowed payment methods, catalog; detail with locations and buyers + roles), Applications (approve with catalog/terms, reject with reason), Catalogs (settings, variants with fixed price / %, quantity rules, up to 10 volume prices), Orders & balances (wholesale orders with PO, overdue flag, record/void installments, outstanding report + CSV).
- 4 component tests (list, application approve dialog, balances/orders, error + retry). NOT checked in a real browser or on a phone; web `tsc -b` shows one error from another session (`navigation/socialLinks.ts`), none in these files.

## Done (slice 5: storefront, both themes)
- Backend: checkout `allowedPaymentMethods` is narrowed by the company allow-list and gets `b2b_terms` (single store + terms); seller gateways / custom methods are filtered by the same list; `POST api/checkout/b2b-po-number`; `POST api/b2b/storefront/quick-order` (<=100 SKU lines, this store only, wholesale price + rules per line).
- Web, headless (`core/checkout`): `terms` pay option, `placeTerms`, PO number saved (debounced + before any order is placed), `b2bTerms.ts` (terms text, quick-order parser). Maison and Tech `PaymentStep`: PO field for wholesale checkouts and the pay-on-terms panel (both use the shared hook, each in its own style).
- `/wholesale` page (route key `wholesale`, neutral `DefaultWholesalePage` fallback for every theme incl. Liquid): apply form, pending / rejected (reason) / approved status with terms, quick order (paste or CSV, per-line errors, add good lines to cart).
- Tests: 17 backend (real Mongo: prices, quick order, store isolation, PO endpoint, method filter), web 5 page tests + 3 payOptions + 4 parser tests.

Not done in slice 5: wholesale price shown on product/cart pages in the themes (the `prices` endpoint exists but no theme calls it yet, so the cart shows retail prices until checkout), hidden prices for visitors, B2B-only sections, company addresses at checkout, a nav link to /wholesale (the seller adds it as a menu link), en/ur and other-language strings (English fallback), Liquid context. Reorder = the existing Buy again on order pages.

## Done (slice 6: prices in themes, wholesale-only store)
- Cart view (`CartService.getCart`) returns the company buyer's wholesale unit price and total, recomputed from the live variant price and the line quantity (volume breaks), with `b2bPriced` / `b2bError`; a line the company may not buy is `unavailable` (blocks checkout), a quantity-rule break only warns. Both themes show the reason in cart page and mini cart.
- `Store.wholesaleOnly`: server refuses add-to-cart (`CartService`) and checkout creation (`B2B_ONLY`) for anyone but an approved company buyer; public store data carries the flag; seller switch on the Wholesale page. Themes (Maison + Tech): product cards hide prices, product page hides price/quantity/buy buttons and shows a sign-in / apply link. Honest limit: the public product API still returns retail prices (a hidden price, not a secret).
- Product page (both themes): "Your wholesale price" with volume tiers from the server `prices` endpoint; headless `core/b2b/useWholesale.ts` (`useWholesaleGate`, `useWholesalePrice`, standing cached 30 s).
- Tests: 4 backend real-Mongo cart tests; 5 hook tests; wholesale hub tests still pass.

Limits: wholesale price is not shown on product cards or in search/collection grids (cards only hide retail when locked); no B2B-only sections/pages; checkout pages themselves do not re-check the lock in the UI (the server does).

## Not done yet (next slices)
1. Storefront UI: wholesale application page, B2B price display in themes (via the prices endpoint), PO number field at checkout, quick order list / CSV, reorder, company addresses, hide-prices-for-visitors store setting, shared theme components, Liquid context. NOT tested: the createCheckout hook itself against a real database (it is only exercised through the context service and type-checked).
2. Reminders for due/overdue invoices (email/WhatsApp), deposit check on partial fulfilment.
4. Plan limits via entitlements (not added yet).
5. Returns/exchange check on B2B orders; en/ur strings; email/WhatsApp notices for application decisions.
