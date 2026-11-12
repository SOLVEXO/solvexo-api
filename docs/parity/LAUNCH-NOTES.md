# Launch notes (MASTER 2, Q0-Q9)

## Order of deploy
1. Atlas backup/snapshot.
2. API first (Railway), watch boot log for index-build errors, then web (Vercel, check `tsc -b` passes on the merged branch).
3. Keys/accounts below are only needed for the live parts of each feature; without them each feature stays inert or manual.

## Migrations and rollback
| Change | What happens on boot | Rollback |
|---|---|---|
| All Q1-Q7 schemas (B2B, fulfilment services, product subscriptions, checkout rules, experiments, app platform) | Additive: new collections/optional fields only, no existing document is rewritten. New indexes are built on boot. | Redeploy the previous API; leave the collections (unused). |
| `ApiToken.appInstallId`, `WebhookSubscription.appInstallId` (Q7) | Optional field, `null` for all existing rows; cap counts filter `appInstallId: null`. | Redeploy previous API; app-created tokens would then look like normal merchant tokens: revoke them (uninstall the apps first). |
| Role presets v9 (`apps.view` for Store Manager) | Merged once into existing preset rows. | Remove the key by hand if wanted; harmless. |
| Plan catalog v5 (earlier work) | Re-aligns plan limits, prices untouched. | Restore plan documents from the backup. |
| New unique indexes (e.g. experiment, subscription cycle, app install) | Fail to build only if duplicate rows already exist (none can, collections are new). | n/a |

## Route auth scan (Q9a)
`src/common/route-auth-scan.spec.ts` reads every `*.controller.ts` with the TypeScript AST and fails when an HTTP route has no `@UseGuards(...)` (class or method level) and is not in `route-auth-allowlist.json`. 169 routes are allow-listed: auth/OTP/reset, signed-link and token endpoints, webhooks (signature checked in the handler), public storefront reads, throttled public forms. A new public route must be added to the list on purpose. The scan proves "a guard is present", not that the guard is the right one or that ownership is checked inside the service: ownership/tenant checks are covered by the per-module isolation tests below.

## Other Q9 checks
- (b) Cross-tenant isolation: each new module has a spec (real Mongo) covering wrong store / wrong seller / buyer-on-seller-route (B2B, fulfilment, subscriptions, checkout rules, experiments, app platform). No new module was added in Q8 (web only).
- (c) Indexes: every new collection leads its indexes with `storeId` (or a unique token/hash key for public lookups) by schema design. NOT checked with `explain()` on Atlas data volumes.
- (d) Audit categories: `activity-categories.spec.ts` passes (every literal `category:` is registered, including `apps`).

## Findings
- P1: none open from this run.
- P2: tokens issued to apps never expire (revoked only by uninstall/revoke); no refresh tokens.
- P2: route scan cannot see ownership checks inside services.
- P3: Q8 canvas export depends on the image host sending CORS headers; failure shows an error toast.
- P3: other sessions' uncommitted web files were left untouched in the working tree.

## Owner's keys / documents to collect (nothing here is verified live)
Couriers (account + API keys + sandbox), Meta WhatsApp Business (token, templates), SMS provider, Qisstpay merchant docs, Stripe Connect enabled + Safepay sandbox, Redis (production URL, for crons/queues), Google Search Console token, image-enhancer vendor (feature is a stub), FBR licence/token, `ANTHROPIC_API_KEY`, Brevo/Resend + SPF/DKIM/DMARC.

## FINAL run additions (phase N and follow-ups; see PROGRESS-FINAL.md)
**Deploy:** API first, then web. No migration, no new index, no schema change in this run (the orders `view` filter reads existing fields: `isPaid`, `sellerOrders.status`, `codProtection.confirmation.status`). Rollback = redeploy the previous builds.
| Change | Where | Notes |
|---|---|---|
| Sidebar regrouped (Shopify-style), `navConfig.ts` extracted | web | Paths unchanged, old URLs work. Security (2FA) is reached from Account (and Ctrl+K), not the sidebar. Staff see only groups they hold permissions for. |
| Customers tab strip (Customers / Companies / Khata) | web | Layout route only; filtered by permission and plan (wholesale needs `b2bWholesaleAllowed`). |
| Orders list: view tabs, no row menu, bulk Mark as paid + Export CSV | web + api | API: new optional `view` query (`unfulfilled`, `open`, `unpaid`, `cod_awaiting`; anything else ignored). Bulk Mark as paid calls the per-order endpoint, so ownership + `orders.record_payment` still apply per order. CSV is the current page only and formula-safe. |
| Edit order in the order detail action buttons | web | Same permission (`orders.edit`) and window as before. |

**Tests added in this run:** `navConfig.test.ts` (6, vitest), `seller-order-view.integration.spec.ts` (6, real Mongo, needs `ORDERVIEW_IT_MONGO`), `fulfil-stock.integration.spec.ts` (7, real Mongo, needs `STOCK_IT_MONGO`), `scheduler-guard.spec.ts` (8, static + fake Redis). Run with `scripts/mini-jest.cjs` (real jest does not load on the dev machine); the two integration specs also need a `beforeAll` shim there (they use plain jest hooks). Browser: sidebar at 1366 / 375 px, orders tabs, Customers tab strip, checked in Chrome against a MOCKED API.

**Verified on the real local stack (2026-11-12: real API build + local mongod 7 + fake Redis + vite + Chrome, seeded seller/store/3 COD orders):** `view` filter over HTTP (unfulfilled, open, unpaid, cod_awaiting), the six order tabs, no row menus, bulk Export selected (CSV downloaded), bulk Mark as paid (2 orders became paid + completed in the database), Edit order button on an editable order, no page errors. **Not verified:** real Stripe/SMTP/Redis, 375 px order and Customers pages, Atlas `explain()`. Found and fixed: bulk export button was labelled "Export CSV" like the page header button, now "Export selected".

**Needs the owner (accounts, keys, documents), grouped by feature**
| Feature | What to collect | Without it |
|---|---|---|
| Couriers (tracking, booking) | Account + API keys + sandbox per courier | Booking/tracking sync stays off; manual tracking still works |
| WhatsApp (COD confirmation, order messages) | Meta Business account, token, approved templates | COD confirmation goes by email only; WhatsApp events stay off |
| SMS | An SMS provider account + sender id | No SMS; email only |
| Qisstpay | Merchant docs + sandbox keys | Option not offered |
| Stripe Connect / Safepay | Connect enabled on the platform account, webhook endpoint with connected-account events; Safepay sandbox | Card checkout unavailable; direct gateways untested |
| Redis (production) | `REDIS_URL` | Crons, queues, locks do nothing; downloads and throttling degrade |
| Google Search Console | OAuth client / token | Search Console tab stays read-only/empty |
| Image enhancer | A vendor + key (feature was removed with AI Studio; nothing to collect unless it is rebuilt) | n/a |
| FBR digital invoicing | Solvexo FBR registration + token + sandbox docs | Invoicing stays disabled |
| Anthropic | `ANTHROPIC_API_KEY` (+ `AI_PROVIDER=claude` for translation) | Auto-translation, sales agent, AI SEO off; photo vetting falls back to people-free photos |
| Email at scale | Brevo or Resend + SPF/DKIM/DMARC on `solvexo.store` | All mail shares one Gmail sender (~500/day, spam risk) |

**P0-P3 findings from this run:** P0/P1 none. P2: orders-list bulk actions work on the current page only (no select-all-matching); tag/archive bulk actions do not exist for orders. P3: some sidebar group/item labels repeat (e.g. "Marketing | Marketing"); `permission-coverage` and route-auth scans cannot see ownership checks inside services; one unrelated type error exists in another session's `apple-signin-5g1.integration.spec.ts`.
