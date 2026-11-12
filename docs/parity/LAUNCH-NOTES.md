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
