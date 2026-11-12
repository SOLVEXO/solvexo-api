# SOLVEXO MASTER PARITY RUN: Shopify-grade core + Pakistan-local

## FIRST ACTION (session 1 only)
Save this ENTIRE prompt verbatim to docs/parity/MASTER.md and create docs/parity/PROGRESS.md (table: phase | status | commit | not-verified) and docs/parity/OPEN-QUESTIONS.md. Commit. In later sessions the owner only says: "Read docs/parity/MASTER.md and PROGRESS.md and continue." Never redo finished phases.

## GLOBAL RULES
- Read CLAUDE.md. Work directly on `uzair-branch`. NEVER commit to main. Do NOT push. Never commit local-only files. Commit after every phase (`feat(<phase>): ...`), then continue to the next phase automatically until limits are near; finish the current phase cleanly, update PROGRESS.md, commit, stop.
- Benchmark: Shopify behaviour (admin UX, storefront, order/inventory correctness) adapted to Solvexo, plus Pakistan-local needs. Reuse existing patterns (schemas additive/optional with safe defaults, DTO validation, store-scoped queries, staff permission registry incl. presets+guards+permission tests, entitlements, writeAuditLog, IdempotencyInterceptor, queues/scheduler, notification/WhatsApp events, ui-locales en+ur, existing web api clients/components, customer segments, draft orders, order-documents). Inspect existing code first; extend, do not duplicate or invent parallel systems.
- Money model unchanged: seller owns buyer money; Solvexo never holds/credits/fronts money, no ledger of seller sale funds, no lending. Net terms / khata = seller-side records only.
- Security: never trust client storeId/sellerId; ownership + staff permission on every route; validate input; no raw user Mongo operators; store-scoped data only (never share customer data across stores).
- External services (WhatsApp Meta, SMS gateways, Qisstpay, couriers, Google/Meta feeds): build behind provider interface + registry, DISABLED by default (config flag), `verified:false`, hidden from sellers until the owner enables; mock-HTTP tests only; never guess unknown API fields: isolate them in one mapping file marked "VERIFY AGAINST OFFICIAL DOC" and log each unknown in OPEN-QUESTIONS.md. No live calls.
- Testing: try to make real-MongoDB tests runnable (mongodb-memory-server as devDependency, or docker mongo / replica set). If impossible on this machine, still write them in a separate jest project that runs only when MONGO_TEST_URI is set and print the exact command for the owner. Run backend tsc + relevant tests, web `tsc -b` + relevant tests per phase. Report exactly what ran. Never claim "production-ready"/"verified" without real-DB + browser evidence.
- Token discipline: grep/list before reading; read only needed files; short tool output; no re-reading finished work.
- Each phase is done only with: backend + frontend + permissions + en/ur strings + tests + short docs in docs/parity/<phase>.md.

## PHASES (in order)
P0 THEME PARITY: shared components/helpers extracted from Maison (pre-order label+button+availability, bundle "includes" list, cart line pre-order/bundle notice, cart upsell block, checkout line note) and used by EVERY storefront theme in its own style; add to THEME_CONTRACT.md; do not change Maison behaviour. List themes first and report which pieces each lacks.

P1 REAL-DB TESTS + MONEY-PATH HARDENING: harness above; tests for checkout (stock reservation, concurrent last-unit orders, coupon usageLimit race, gift card/store credit redemption, totals/tax), payment webhook idempotency (duplicate/out-of-order), finance/refund paths, bundles + pre-order limit under concurrency, POS and draft-order bundle stock, order cancel/return restock. Fix real bugs found (smallest change). Report bugs found.

P2 B2B (Shopify B2B parity, seller-owned wholesale, no platform credit):
 - Companies (+locations, buyers, tax-exempt flag, tax id), wholesale application on storefront with seller approve/reject (email/WhatsApp notice), customer tags/segments reuse.
 - Catalogs: product/variant availability, price (fixed or % adjustment), quantity rules (min/max/increment per variant; reuse existing product order quantity fields), volume pricing (up to 10 price breaks per variant; not a discount). Catalog assigned to company (and location override optional). Plan limits via entitlements like other features.
 - Storefront/checkout: B2B-aware prices, rules and visibility only for approved buyers; server recomputes prices and enforces rules at cart + checkout (never client prices); PO number field; quick order list (SKU+qty, CSV upload), reorder from past orders, purchase history; company location shipping/billing addresses.
 - Payment terms: due on order / net 15-30-60 / due on fulfilment, plus COD/bank transfer; order stays payment-pending with due date until seller marks paid; reminders via existing email/WhatsApp; overdue flag.
 - Seller admin: companies/locations/buyers CRUD, catalogs, draft orders for a company (extend draft-orders), company order list, outstanding balance report, CSV export. Liquid/theme context exposes B2B price when applicable.
 - Tests: price resolution precedence, volume breaks, quantity rule enforcement server-side, wrong-store/company isolation, unapproved buyer denied, terms due-date, old customers unaffected.

P3 COD PROTECTION (Pakistan RTO/fake-order control, store-scoped only):
 - Store rules: max COD amount, require confirmation for new customers / high value / flagged cities, blocked phone/address list (per store), minimum prepaid for risky orders.
 - Order risk score from the store's OWN history (past returns/RTO/cancels, unreachable) + rule hits; show on order detail with reasons; seller can override with audit.
 - Confirmation flow: COD order enters "awaiting confirmation" using the EXISTING order status machine safely (no breaking transitions); buyer gets WhatsApp/SMS/email with a one-time signed confirm/cancel link; auto-cancel after N hours (scheduler, idempotent, restock correctly); confirmed orders proceed normally.
 - Courier RTO from the courier module feeds the customer's store-scoped history; dashboard widget: confirmation rate, RTO rate, saved amount.
 - Tests: transitions, token expiry/replay, auto-cancel restock, tenant isolation, rules matrix.

P4 MESSAGING CHANNELS (Meta rules): 
 - WhatsApp marketing broadcast via Cloud API: marketing messages MUST use Meta-approved templates (template list/status sync + submit, mapping file unverified); explicit per-contact WhatsApp opt-in record (source, timestamp), separate from email/SMS consent; opt-out (STOP keyword/link) processed immediately and excluded from every future send; campaigns target customer segments; throttle to messaging-tier limits (new accounts ~1,000 unique contacts/24h), batch + retry via queue, delivery/read status webhooks, per-campaign stats, cost note per delivered message (Meta bills per delivered template message). Reuse email-campaigns engine/queues.
 - SMS: provider interface + generic HTTP-gateway adapter + Pakistani gateway adapters (unverified), consent + opt-out, campaigns on segments, sender-id config, per-message log.
 - Tests: consent/opt-out exclusion, template-only enforcement, throttling, idempotent sends, tenant isolation.

P5 KHATA (customer ledger, seller records only): per-store customer ledger with append-only entries (credit sale linked to order or manual, payment received with method/reference, adjustment, reversal entries instead of deletes), running balance, aging buckets, credit limit per customer (seller-set), statements (printable/PDF via order-documents style, CSV), reminders through P4 channels with consent, B2B net-terms invoices auto-create receivables, POS "sell on udhaar" for a registered customer, permissions, audit log, concurrency-safe balance updates. Tests for balance integrity, reversal, limits, tenant isolation.

P6 PRODUCT FEEDS: per-store tokenized public feed URLs for Google Merchant and Meta catalog (RSS/XML + CSV): variants as items with item_group_id, availability (stock/backorder/pre-order/bundle-derived), price per market/currency, image, brand, gtin/mpn, condition; feed health page listing products with missing required fields; "Sales channels" settings page. No API keys needed. Tests for field mapping and availability.

P7 QISSTPAY (BNPL): adapter in the payment provider registry, disabled+unverified, "pay in installments" messaging on product/checkout only when enabled; docs/keys go to OPEN-QUESTIONS.

P8 MERCHANT WEBHOOKS + API TOKENS (inspect what exists first): webhook subscriptions per store (order created/paid/fulfilled/cancelled, refund created, product updated, inventory changed, customer created), HMAC-SHA256 signature header + timestamp, retries with backoff via queue, delivery log + manual redeliver, auto-disable after repeated failures, secret rotation; scoped API tokens (read/write per resource, hashed at rest, shown once, revocable, rate-limited, audited). Tests for signature, retry, scoping, isolation.

P9 SEARCH & DISCOVERY: seller-managed synonyms, pinned/boosted products, filter configuration, predictive search, "no results" report; keep existing search behaviour as default.

P10 NOTIFICATION TEMPLATES: seller-editable customer email templates for core order emails (safe allow-listed variables, no code execution, preview, reset to default, en/ur).

P11 AI STUDIO HONESTY: the image enhancer is a stub that returns the original image: either wire a real provider behind a key (unverified) or hide the tool/label it clearly so sellers are not misled; add tests for wallet/ledger and remaining AI features.

P12 SELLER + STAFF 2FA (TOTP + recovery codes; extend the existing platform-admin 2FA implementation, not a second system): login challenge, store-level "require 2FA for staff", owner/admin reset with audit, step-up verification for sensitive actions (email/password change, disable 2FA, payment/courier credentials, staff removal), lockout + replay protection, UI + en/ur, tests.

## NOT IN THIS RUN (do not start; list in OPEN-QUESTIONS.md as deferred)
Product subscriptions (selling plans), Shopify Functions/checkout extensibility, 3PL fulfillment services, A/B testing, third-party app platform (OAuth/extensions), FBR POS integration (needs FBR license or licensed partner), Safepay recurring (needs docs), multi-wholesaler marketplace network, lending/credit.

## REPORTING
After each phase print max 6 lines: done/partial, exact commands+results, NOT verified, open questions. At the very end: PROGRESS.md summary + list of everything the owner must supply (keys/docs/sandboxes) + ONE next task. Never claim production-ready.

## ADDENDUM TO P2 (B2B): part of P2, do it inside P2, not later
- Buyer roles per company location: "ordering only" vs "location admin" (admin manages buyers/addresses/orders of that location), enforced server-side.
- Partial payments on payment-terms orders: seller records installments (amount, date, method, reference); order shows paid/outstanding; optional seller-recorded deposit requirement. Solvexo moves no money.
- Per-company/location allowed payment methods (e.g. COD off for wholesale, bank transfer + net terms only), enforced at checkout server-side.
- B2B storefront controls: store setting to show prices/cart/checkout only to approved B2B buyers (hidden for visitors), B2B-only sections/pages visibility, built on the P0 shared theme components so every theme supports it.
- Company credit limit (seller-set record): checkout warns/blocks new net-terms orders above limit; shares data with P5 Khata, no duplicate ledger.
- Auto tag/segment "b2b" for approved buyers; B2B orders must work with the existing returns/exchange flow (verify and fix).
- Tests: role enforcement, partial-payment balance integrity, payment-method restriction, hidden-price visibility for visitors, limit enforcement, tenant isolation.
