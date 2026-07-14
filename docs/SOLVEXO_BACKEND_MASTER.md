
# SOLVEXO BACKEND — MASTER REFERENCE

**This is the ONLY backend reference document for this project.** It was produced by a single, complete read-through of every file in `E:\solvexo-api\src` (2026-07-14), and updated 2026-07-14 with the new SEO module (see §5.7). Do not re-scan the whole backend again — follow the workflow below instead.

## 0. Workflow — read this first

1. **Read this file** before starting any backend task.
2. Understand the relevant module(s) from the reference below.
3. Implement the requested feature.
4. **Update this same file** (the relevant module section + the Changelog at the bottom + the stats table if counts changed).
5. Never create a second master document. Never re-scan the entire backend from scratch — only re-read the specific module(s) you're touching, and trust this document for everything else unless you have concrete reason to believe it's stale (check git history/dates in the Changelog).

---

## 1. Project Overview

Solvexo ("Qchicken API" per Swagger title — legacy naming, not corrected) is a multi-tenant e-commerce marketplace backend built on **NestJS 10 + MongoDB (Mongoose)**. A single seller account can own **multiple stores**; each store can sell physical products, digital downloads, educational resources, and run an in-person POS. The platform layers three separate revenue streams:

1. **Marketplace commission** — a per-sale transaction fee taken from seller order revenue (rate depends on the seller's platform plan tier).
2. **Seller platform billing** — sellers pay Solvexo monthly/yearly for platform access tiers (product/staff/location limits, feature gates, AI credits, add-ons).
3. **Buyer subscriptions** — sellers can sell their *own* VIP/membership plans to their store's buyers (discounts, free shipping, loyalty multipliers), with Solvexo taking a commission cut of that revenue too.

The codebase shows clear signs of iterative, real-world development: some features exist in two parallel/competing implementations (see §15), some scaffolding is unwired dead code, and some modules (Firebase, Refund-Request) are stubs. This document calls out every such case explicitly so future work doesn't rediscover them the hard way.

**Stack**: NestJS 10, Mongoose/MongoDB, Redis (`redis` npm client, not `ioredis`), BullMQ (2 queues), Stripe (`stripe` SDK), Cloudinary (file storage), nodemailer (email), Passport-JWT (auth), `@nestjs/throttler` (rate limiting), `@nestjs/schedule` (cron), Socket.IO (`@nestjs/websockets`) for 2 realtime gateways, Swagger (`@nestjs/swagger`) at `GET /api`.

---

## 2. Statistics at a Glance

Raw file counts (ground truth, `find src -name "*.X.ts"`):

| Metric | Count |
|---|---|
| **Total Modules** (`*.module.ts`) | 36 (38 module directories; `admin/` and `seller/` are schema-only, no module file) |
| **Total Controllers** (`*.controller.ts`) | 57 (34 pre-SEO + 23 in `seo/`; 2 pre-SEO are non-functional: `otp.controller.ts` fully commented out; `refund-request.controller.ts` is a 0-byte file) |
| **Total Services** (`*.service.ts`) | 59 (45 pre-SEO + 14 in `seo/`) |
| **Total Schemas** (`*.schema.ts`) | 72 (59 pre-SEO + 13 in `seo/`; 2 pre-SEO are dead/unregistered: `TokenBlacklist`, `Otp`; `refund-request.schema.ts` is 0 bytes) |
| **Total DTOs** (`*.dto.ts` files) | 109 files (96 pre-SEO + 13 in `seo/`; ~145+ exported DTO classes total) |
| **Total Database Tables** (live Mongo collections) | ~67 top-level collections (~54 pre-SEO + 13 new SEO collections, see §6) |
| **Total APIs** (HTTP endpoints, active/routable) | **~421** (~342 pre-SEO + 79 in `seo/` — see §5.7 for the SEO breakdown; pre-SEO breakdown: Auth 15, Store 16, Products 13, Categories 3, Inventory 1, Banner 6, Faqs 8, Cart 10, Checkout 4, Orders 14, Payment 2, POS 52, Finance 16, AdminFinance 18, PlatformAddons 4, PlatformPlans 8, SellerPlatformSubscriptions 6, PlatformSubscriptions 9, Subscriptions 45, StripeWebhook 1, Marketing 4, Loyalty 15, Messaging 22, Rating 12, Address 7, Analytics 11, AdminAnalytics 16, Health 2, ActivityLog 3, Upload 2) |
| **Total Events** (EventEmitter2 domain events + Socket.IO gateway events) | 6 Stripe domain events (`stripe.invoice.payment_succeeded/failed`, `stripe.customer.subscription.updated/deleted`, `stripe.payment_intent.succeeded/payment_failed`) + 2 Socket.IO gateways emitting ~14 distinct event names combined (see §8). SEO added 0 new domain events (request/response + cron/queue-driven only). |
| **Total Listeners** (`@OnEvent` handlers) | ~9 (`SubscriptionsService` listens to all 6 Stripe events; `SellerPlatformSubscriptionsService` listens to 3 of them) |
| **Total Cron Jobs** (`@Cron` in `scheduler.service.ts`) | 18 (13 pre-SEO + 5 SEO: `regenerateSitemaps`, `syncSearchConsoleData`, `syncGoogleAnalyticsData`, `refreshCoreWebVitals`, `runScheduledSeoAudits`) |
| **Total Queues** (BullMQ) | 5 (`stripe-webhooks`, `subscription-emails` + SEO's `seo-sitemap`, `seo-audit`, `seo-ai`) + 5 processors |
| **Total Shared Utilities** | 5 files in `common/` + 6 files in `analytics/utils/` (shared by both `analytics` and `admin-analytics`) = 11 |
| **WebSocket Gateways** | 2 (`ActivityLogGateway` at `/activity-log`, `MessagingGateway` at `/messaging`) — SEO added none |

---

## 3. Global Architecture & Bootstrap

**`main.ts`**:
- No global route prefix — every controller hardcodes its own `api/...` (or, inconsistently, bare `address/`, `health`) prefix.
- Global `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false })` — added specifically because several controllers previously applied their own local pipes inconsistently (Rating/Analytics/AdminFinance/AdminAnalytics had one, Subscriptions had none). `whitelist` strips unknown fields rather than rejecting, for backward compatibility.
- `cookie-parser` enabled.
- Swagger UI at `GET /api`, bearer auth scheme `accessToken`.
- CORS: explicit origin whitelist (`localhost:3000/5173/5174`, `127.0.0.1` equivalents, `staging.solvexo.store`, `solvexo.store`, `api.edudeen.com`) + any `localhost`/`127.0.0.1` port when `NODE_ENV !== 'production'`. `credentials: true`.
- Listens on `process.env.PORT || 3002`, `0.0.0.0`, server timeout 300000ms (5 min — generous, likely for large file uploads).

**`app.module.ts`**:
- `ConfigModule.forRoot({ isGlobal: true })`, `EventEmitterModule.forRoot()` (powers the Stripe webhook fan-out), `ThrottlerModule.forRoot([{ name:'default', ttl:60_000, limit:100 }])` applied globally via `APP_GUARD: ThrottlerGuard` (100 req/min/IP default; individual routes override with `@Throttle()`/`@SkipThrottle()`).
- Imports (in order): `DatabaseModule`, `QueueModule`, `HealthModule`, `ActivityLogModule`, `AuthModule`, `categoryModule`, `ProductsModule`, `CartModule`, `AddressModule`, `UsersModule`, `OtpModule`, `UploadModule`, `BannersModule`, `FaqModule`, `CheckoutModule`, `OrdersModule`, `PaymentModule`, `StoreModule`, `InventoryModule`, `RatingModule`, `PosModule`, `MessagingModule`, `FinanceModule`, `SubscriptionsModule`, `PlatformPlansModule`, `SchedulerModule`, `MarketingModule`, `LoyaltyModule`, `AnalyticsModule`, `PlatformSubscriptionsModule`, `AdminAnalyticsModule`, `AdminFinanceModule`.
- **`RefundRequestModule` import and registration are both commented out** — not part of the running app at all.

**Central DB access pattern**: Almost every module (exception: `FaqModule`, `RatingModule` import `DatabaseModule` directly; `FaqService` uses per-module `@InjectModel`) does **not** use per-module `MongooseModule.forFeature()`. Instead `database/database.module.ts` (`@Global()`) registers all ~59 schemas once, and `database/databaseservice.ts` injects every model and exposes them through one getter: `DatabaseService.repositories.<modelName>` (e.g. `.userModel`, `.storeModel`, `.orderModel`). Every service in the app pulls its models from this single object. `database/schema.ts` is a pure re-export barrel so `database.module.ts` doesn't need ~35 separate import paths.

**Relationships are NOT Mongoose refs.** Virtually every foreign key in this codebase (`sellerId`, `storeId`, `productId`, `userId`, etc.) is a plain `String` holding a stringified `_id`, resolved by manual application-level queries — there is no `.populate()` usage anywhere observed. Keep this in mind: adding a new relationship means writing the join query yourself, not adding a `ref:` option.

**Known copy-paste bug**: `DatabaseService`'s `otpModel` binding is typed as `Model<OtpDocument>` but is actually wired to the `User` schema — `repositories.otpModel` silently returns `User` documents at runtime. Currently dormant because nothing calls `repositories.otpModel` (OTP state lives directly on `User`/`Seller`/`Admin` documents instead — see §5.1).

---

## 4. Folder Structure

```
src/
├── app.module.ts, main.ts, app.controller.ts, app.service.ts
├── activity-log/        — audit log + Socket.IO gateway (seller-facing)
├── address/             — buyer shipping/billing addresses
├── admin/                — Admin schema ONLY (no controller/service — see §5.1)
├── admin-analytics/      — platform-wide analytics for admins
├── admin-finance/        — platform-wide finance oversight for admins
├── analytics/            — seller-scoped analytics + shared aggregation utils
├── auth/                 — signup/login/OTP/JWT/roles (all 3 account types)
├── banner/               — homepage promo banner carousel (admin-managed)
├── cart/                 — shopping cart + wishlist
├── categories/           — 2-level category taxonomy
├── checkout/             — cart → checkout staging (pricing, shipping, subscriber discounts)
├── common/               — idempotency interceptor, money/earnings utils, store-ownership checks
├── database/             — Mongoose connection + central model registry
├── faqs/                 — public FAQ knowledge base
├── finance/              — seller ledger, balances, payouts, tax reports
├── firebase/             — DEAD — empty module, commented-out FCM scaffold
├── health/               — liveness/readiness probes
├── inventory/            — read-only seller stock dashboard
├── loyalty/              — per-store points/tiers/rewards program
├── marketing/            — per-store discount coupons
├── messaging/            — buyer↔seller chat + Socket.IO gateway
├── orders/               — post-payment order records, fulfillment, returns, digital delivery
├── otp/                  — mostly-dead OTP scaffold; only `OtpService.sendOtp` (mailer) is live
├── payment/              — checkout→order finalization (Stripe fully commented out)
├── platform-plans/       — seller↔Solvexo billing v2 (DB-driven tiers, entitlements, AI credits, add-ons)
├── platform-subscriptions/ — seller↔Solvexo billing v1 (legacy, hardcoded tiers) — still live, parallel to platform-plans
├── pos/                  — in-store POS (locations, employees, registers, shifts, sessions, sales)
├── products/              — product/variant catalog
├── queues/                — shared BullMQ infrastructure (2 queues)
├── rating/                — product reviews/ratings + seller replies
├── redis/                 — Redis client wrapper (KV + distributed locks)
├── refund-request/        — DEAD — all files 0 bytes, module unregistered in app.module.ts
├── scheduler/             — all 18 cron jobs (13 pre-SEO + 5 SEO)
├── seller/                — Seller schema ONLY (no controller/service in this dir — see §5.4)
├── seo/                   — Admin/Platform SEO + Seller/Store SEO (see §5.7) — 23 controllers, 14 services, 13 schemas
├── store/                 — seller storefronts (multi-store-per-seller)
├── subscriptions/         — buyer-facing VIP/membership plans, Stripe integration, webhook processing
├── upload/                — Cloudinary-backed file upload + PDF watermarking
└── users/                 — buyer self-service profile
```

---

## 5. Module Reference

### 5.1 Identity & Access — `auth/`, `users/`, `otp/`, `admin/`, `activity-log/`

**Three parallel identity collections** — `User` (buyers), `Seller`, `Admin` — near-identical shape, selected at runtime by a plain `role: string` (`'user'|'seller'|'admin'`, no enum, no discriminator schema). All signup/login/OTP/profile logic for **all three roles** lives in one role-branching `AuthController`/`AuthService` — there is no separate admin auth surface.

#### `auth/` — `AuthController` (`api/auth`, no class guard, mixed per-route)

| Method | Path | Guard | Purpose |
|---|---|---|---|
| POST | `register` | none | Role-branch create; generates OTP (5 min); **returns OTP in the response body** (dev/testing leftover — security concern in prod) |
| POST | `login` | none | bcrypt check + `isVerified` required; issues JWT (7d default) + Redis session (24h TTL — mismatched, see quirks); logs seller login events to ActivityLog |
| POST | `resend-otp` | none | New OTP, 10 min expiry (inconsistent with signup's 5 min) |
| POST | `verifyOtp` | none | Sets `isVerified`, issues 1h token + 30min Redis session |
| POST | `forgot-password` | none | New OTP (5 min) — reuses the same `otp`/`otpExpiresAt` fields as signup |
| POST | `reset-password` | none | Validates OTP, hashes new password |
| GET | `getprofile` | JwtAuthGuard | Role-branch fetch, strips password/otp |
| PATCH | `edit-profile` | JwtAuthGuard | Role-branch update |

**Guards/strategies**: `JwtStrategy` (passport-jwt, verifies against `JWT_SECRET`) → `JwtAuthGuard` (extends `AuthGuard('jwt')`, additionally requires the token to exist as a Redis key — a de facto single-session/revocation mechanism; if Redis is down, falls back to trusting the JWT signature alone). `OptionalJwtAuthGuard` (never blocks, sets `req.user = null` on failure). `RolesGuard` + `@Roles(...)` decorator (reads `req.user.role` string, no ACL/permission granularity beyond the 3 literal roles). `GetUser` param decorator.

**Schema `User`** (`users/schemas/user.schema.ts`, collection `users`): `name`, `email` (unique), `providerId`, `authProvider`, `phone`, `address`, `password?` (absent for social accounts), `otp`, `otpExpiresAt`, `isVerified`, `profileImage`, `fcmToken`, `status` (default `active`), `role`, `isDelete`, `stripeCustomerId` (indexed — one Stripe customer per platform user, shared across every seller's VIP plan they subscribe to).

**Schema `Admin`** (`admin/admin.schema.ts`, collection `admins`) — same shape minus `providerId`/`authProvider`/`stripeCustomerId`. **No controller/service exists in `admin/` — it is schema-only.** Real admin-specific business logic lives in `admin-analytics/` and `admin-finance/`.

**Quirks/dead code**: `TokenBlacklist` schema defined but unregistered/unused (no logout/blacklist flow exists — "logout" = relying on Redis TTL). `RefreshTokenDto` + 4 properly-validated DTOs (`VerifyEmailDto`, `ResendVerificationDto`, `ForgotPasswordDto`, `ResetPasswordDto`) exist but the controller uses untyped inline `@Body()` instead — **zero request validation on those 4 routes**. `SocialLoginDto` + a constructed but unused `google-auth-library` `OAuth2Client` — social login groundwork, not wired to any route. Mismatched JWT-vs-Redis TTLs mean real session life is capped by the Redis TTL, not the JWT's own expiry.

#### `users/` — `UsersController` (`api/users`, class guard `JwtAuthGuard`)
`GET/PUT/DELETE profile`, `PUT change-password`. Buyer-only (no seller/admin equivalent module — those go through `auth/`). `deleteAccount` is soft-delete only, no cascade, no session invalidation. Email change on `updateProfile` un-verifies the account but does **not** auto-resend an OTP.

#### `otp/` — mostly dead
`OtpController` is **entirely commented out**, 0 active routes. Only `OtpService.sendOtp(toEmail, otp)` (a bare nodemailer mailer, hardcoded `from: 'jamiraza359@gmail.com'`) is actually used, by `AuthService`. A second, more complete mailer `EmailService` (`otp/services/email.service.ts`) exists but isn't a registered provider — not currently injectable. The dedicated `Otp` schema (with `attempts`/`maxAttempts`/`canBeUsed()`/TTL index) is fully unused — real OTP state lives directly on `User`/`Seller`/`Admin` documents instead.

#### `activity-log/` — `ActivityLogController` (`api/activity-log`, class guard `JwtAuthGuard,RolesGuard` + `@Roles('seller')`)
`GET :storeId` (paginated/filterable), `GET :storeId/stats`, `GET :storeId/export` (CSV, capped 5000 rows). `ActivityLogService.log()` is the write path used by every other module for audit trail — wrapped in try/catch that **never throws** ("logging must never break the operation that triggered it"), defaults `storeId` to sentinel `'platform'` for non-store-scoped actions.

`ActivityLogGateway` — Socket.IO, namespace `/activity-log`. Auth: reads JWT from handshake, verifies independently via its own `JwtService.verify` (bypasses the shared `JwtAuthGuard`/Redis-session check entirely). Events: client emits `join-store`/`leave-store` (re-verifies store ownership before joining room `store:{storeId}`); server emits `activity:new`/`activity:joined`/`activity:error`. `ActivityLogModule` is `@Global()` and deliberately avoids importing `AuthModule` (to dodge a circular dependency with `AuthService`, which depends on `ActivityLogService`) — it re-satisfies `JwtAuthGuard`'s own needs (`RedisModule`) directly instead.

**Schema `ActivityLog`**: `storeId` (default `'platform'`), `actorId/Name/Role`, `category` (enum: products/orders/finance/marketing/customers/settings/security/loyalty/subscriptions/platform_billing/platform_plans), `action`, `description`, `targetId/Type`, `ip`, `userAgent`, `isSecurityAlert`, `metadata`.

---

### 5.2 Catalog & Storefront — `store/`, `products/`, `categories/`, `inventory/`, `banner/`, `faqs/`

#### `store/` — `StoreController` (`api/store`) — 16 endpoints
Multi-store-per-seller model (no "already has a store" check — `Store.sellerId` alone is ownership truth). Key endpoints: `create-store`, `my-stores`, `getStoreById/:storeId` (public), `custom-domain`/`white-label` (both plan-gated via `EntitlementsService.assertFeatureAllowed`), `update-store`, `save-builder-config`/`builder-config/:storeId` (opaque frontend page-builder JSON), `public/:slug`, `public/:storeId/products` (subscriber-pricing aware via `OptionalJwtAuthGuard`), `public/:storeId/filters`, `:storeId/follow`/`follow-status`/`followers`, `:storeId/customers` (derived from order history — no direct customer collection) + `PATCH :storeId/customers/:customerId`.

**Schema `Store`**: `sellerId`, `name`, `slug` (unique), `logo`, `categoryId` (must be a root/main category — no `parentId`), `description`, `sellerType` (enum: creator/educator/retailer/brand_business/freelancer/mix), `productTypes[]` (physical_products/digital_downloads/educational_resources/services_bookings/subscriptions/in_person_pos), `enabledTools[]` (**derived** from `productTypes`, recomputed on every `productTypes` change — desyncs if edited directly in DB), `plan` (enum StorePlan: starter/basic/pro/enterprise), `aiCredits`, `registers[]`/`shifts[]` (embedded — POS cash registers/shift definitions live **on the Store doc**, not their own collection), `builderConfig`, `coverImage`, `customDomain`, `whiteLabelEnabled`, `followersCount` (maintained via `$inc`, can drift), `status`, `badges[]` (admin-granted, e.g. `top_seller`/`verified`/`featured`), `isDelete`.

**Schema `StoreFollower`**: `userId`, `storeId`, unique compound index.

Category must be a **root/main category only**, enforced on both create and update via `assertValidRootCategory`.

#### `products/` — `productController` (lowercase `p` in class name; `api/products`) — 13 endpoints
**Two parallel product-creation code paths coexist**: legacy (`add-product`/`add-product-variant`, no store link, no auto-default-variant) vs. newer store-scoped/plan-gated flow (`create-product`/`create-variant`/`add-physical-product`/`add-digital-product`/`edit-product`). `createProduct` looks up the seller's store via `storeModel.findOne({sellerId})` — **assumes one store per seller**, inconsistent with Store module's explicit multi-store design (`addPhysicalProduct`/`addDigitalProduct`/`getStoreProducts` correctly take an explicit `storeId` instead). Public browse: `products-by-category` (category-tree-aware: subcategory→filter by `subCategoryId`, main category→filter by `categoryId`), `getProductById/:id` (honors early-access window — a subscriber-plan benefit that hides new products from non-subscribers for N hours), `getVariantById/:variantId`.

**Schema `Product`**: `sellerId`, `storeId`, `name`, `slug`, `description`, `productType` (enum physical/digital/educational), `type` (physical/digital — collapses educational into digital), `categoryId`, `subCategoryId`, `images[]`, `tags[]`, `digital` (embedded: `files[]`, `downloadLimit` enum unlimited/1/3/5, `linkExpiryDays`, `pdfStampingEnabled`, `licenseType` enum personal/single_classroom/school/commercial, `buyerDeliveryMessage`), analytics counters (`viewCount`/`wishlistCount`/`purchaseCount`/`averageRating`/`ratingSum`), `status` (active/inactive/draft/scheduled), `scheduledAt`, `earlyAccessUntil`, `isListedOnSolvexo`, `isDelete`.

**Schema `ProductVariant`**: `productId`, `sku`, `barcode`, `price`, `compareAtPrice`, `size`/`color` (physical only), `stock`, `shippingWeight`, `images[]`, `isDefault`, `status`.

`UpdateProductDto`/`ProductQueryDto` are defined but **dead** (not referenced by any route).

#### `categories/` — `CategoriesController` (`api/categories`) — 3 endpoints
Hard **2-level tree cap**, enforced only at write time in `addCategory`: root categories (`parentId` absent) are **admin-only**; subcategories (`parentId` present) are admin **or seller**, and the parent must itself have no `parentId` (throws if you try to nest 3 levels). No update/delete endpoint exists despite `UpdateCategoryDto` being defined (dead DTO).

**Schema `Category`**: `name`, `parentId` (self-ref, null = root), `image`, `description`, `sortOrder`, `status`, `isDelete`, `createdBy`/`createdByRole`.

#### `inventory/` — `InventoryController` (`api/inventory`) — 1 endpoint
Read-only aggregation over `Product`/`ProductVariant` (no own schema). `LOW_STOCK_THRESHOLD = 10` hardcoded. **Bug/gap**: `@Roles('seller','admin')` on the route, but the ownership query still requires `sellerId` to equal the caller's own id — an admin caller effectively can never see another seller's inventory through this endpoint as written.

#### `banner/` — `BannersController` (`api/banners`) — 6 endpoints
Hardcoded `MAX_BANNERS = 4` cap enforced in application code. Two creation paths: direct URL (`CreateBannerDto`) vs. Cloudinary file upload (bypasses the DTO entirely — only `urlOnTap` from query string is used). Cloudinary deletion failures are swallowed (logged, not thrown) — can leak storage.

#### `faqs/` — `FaqController` (`api/faqs`) — 8 endpoints
**Authorization gap**: all "admin" routes (`create`/`update`/`toggle`/`remove`/`admin/all`) use **only `JwtAuthGuard`, no `RolesGuard`** — any authenticated user (including plain buyers) can currently mutate/delete FAQs. Uses MongoDB `$text` search index. The only module in this group using per-module `@InjectModel` instead of the shared `DatabaseService` pattern.

---

### 5.3 Commerce Pipeline — `cart/`, `checkout/`, `orders/`, `payment/`, `refund-request/`, `pos/`

#### `cart/` — `CartController` (`api/cart`) — 10 endpoints
Add/update/remove cart items + a separate wishlist. Most mutating routes take raw `req.body` rather than typed DTOs (only `add-to-cart` uses `AddToCartDto`, and even that has no required-field validators). `Cart.totalItems`/`totalPrice` schema fields exist but are always 0 in storage — real totals computed ad hoc in `getCart`.

#### `checkout/` — `CheckoutController` (`api/checkout`) — 4 endpoints
Converts (a subset of) the cart into a `Checkout` staging doc. `createCheckout` does a deliberate **two-pass** computation: pass 1 resolves per-store raw subtotals (stock validation included); pass 2 applies subscriber discounts only if the store's raw subtotal meets the benefit's `minOrderValueUSD` (a prior single-pass version applied discounts unconditionally — documented fix). `addShippingInCheckout` only applies a subscriber shipping-discount when every item in the checkout belongs to a single store (can't attribute a flat multi-store shipping fee to one membership). 30-minute `expiredAt`. No DTOs at all in this module — zero request validation. File is `checkout.modoule.ts` (typo, kept). Large commented-out legacy controller/service variants remain in the files.

**Schema `Checkout`**: `userId`, `addressId`, `currency`, `items[]` (snapshot: productId/variantId/sellerId/storeId/type/name/image/sku/size/color/licenseType/quantity/price/totalPrice/originalPrice/subscriberDiscountUSD), `shippingZoneId`, `paymentType` (cash_on_delivery/stripe), `subtotal`/`shippingFee`/`taxAmount`/`subscriberSavingsUSD`/`totalAmount`, `status` (pending/payment_pending/completed/expired/cancelled), `expiredAt`, `attributionSource` (marketplace_search/direct_link/social_media/email/other).

**Schema `ShippingZone`**: `country`/`province`/`city`, `shippingPrice`, `estimatedDeliveryTime`, `status`.

#### `orders/` — `OrdersController` (`api/orders`) — 14 endpoints
Post-payment order record, split per-store into embedded `sellerOrders[]`. Key flows: `updateSellerOrderStatus` cascades to items and re-derives order-level status; on transition into `completed` (guarded against double-crediting on retries) triggers `FinanceService.recordSale` + loyalty points award. `cancelOrder` restores variant stock, sets `paymentStatus:'refunded'` **DB-only** (no real Stripe refund call exists anywhere). `returnRequest`/`returnAction` — buyer requests return on delivered/completed **physical items only**; seller approves/rejects; approval triggers `FinanceService.recordRefund` + `LoyaltyService.clawbackPurchasePoints`. Digital delivery pipeline: `getDownloadUrls`/`streamStampedPdf`/`downloadByToken` enforce `isPaid`, `linkExpiryDays` (from `paidAt`), and `downloadLimit`; two routes (`download-file`, `stream-pdf-token`) are deliberately **unguarded** — the signed token itself is the auth. `GET :orderId` is intentionally registered **last** so static routes aren't shadowed.

**Schema `Order`**: `orderNumber` (unique), `userId`, `checkoutId`, `currency`, `sellerOrders[]` (embedded — `sellerId`/`storeId`/`fulfillmentType`/`items[]`/`subtotal`/`status`/`tracking`/`shippedAt`/`deliveredAt`/`cancelledAt`/`cancelReason`/`returnStatus`), `shippingAddress` (null for digital-only orders), `subtotal`/`shippingFee`/`taxAmount`/`subscriberDiscountTotal`/`totalAmount`, `paymentType`, `paymentStatus` (unpaid/paid/failed/refunded), `isPaid`, `paidAt`, `orderStatus` (derived, not client-set), `hasReturnApproved`, `attributionSource`, `isDelete`. `OrderItem` embedded subdoc tracks per-item status/refund/return/download-count independently.

`CreateOrderDto`/`UpdateOrderToPaidDto` DTOs exist but are **unused dead code** — all real endpoints take untyped bodies.

#### `payment/` — `PaymentController` (`api/payment`) — 2 endpoints
**No live payment gateway is actually called** — Stripe integration is fully commented out (~90 lines kept as comments). `place-order` and `cod-payment` both mark the `PaymentTransaction` `completed` **synchronously**, no async gateway confirmation. `createOrder` (private) atomically decrements stock per item with rollback-on-partial-failure, splits checkout items into up to 2 orders (physical + digital), groups each into `sellerOrders[]` by store. `UserPaymentMethod` schema (saved cards) is fully wired (repository+indexes) but **never read/written by any code path** — dead schema for an unbuilt "saved cards" feature.

#### `refund-request/` — **completely unimplemented**
Every file (`controller`, `service`, `module`, `dto`, `schema`) is **0 bytes**. Both the import and registration in `app.module.ts` are commented out. Refund handling that *does* exist lives instead in `OrdersService` (`returnRequest`/`returnAction`, online orders) and `PosService.refundSale` (in-store) — two separate, non-shared code paths.

#### `pos/` — `PosController` (`api/pos`) — 52 endpoints, largest single controller in the codebase
Fully parallel, isolated in-store retail system — shares only `Product`/`ProductVariant` (catalog) and `Store` (for embedded `registers[]`/`shifts[]`) with the online marketplace; **no dependency on Cart/Checkout/Order/Payment** in either direction. Covers: multi-location branches, employees (PIN login, bcrypt-hashed PIN, own 12h JWT with `type:'pos_employee'` **not verified by any shared guard**), registers/shifts (embedded on `Store`, mutated via positional `$` operators — a structural inconsistency vs. every other POS entity having its own collection), register sessions (cash-drawer open/close/force-close with `expectedCash`/`cashDifference` reconciliation), sales (hold/complete/void/refund, atomic per-store `saleNumber` counter via `PosSettings.saleCounter` to avoid concurrent-terminal collisions, **hand-rolled idempotency** via `CreateSaleDto.idempotencyKey` — distinct from and not integrated with the shared `common/idempotency.interceptor.ts`), reporting (daily/range/register/employee/CSV export, computed in JS not Mongo aggregation), settings, audit logs. Heavy route-ordering discipline (static routes registered before param routes, with inline comments warning not to reorder).

**Schemas**: `Employee` (bcrypt `pin` with `select:false`, `role` enum cashier/manager, `locationId`), `PosSettings` (per-store, `taxRate`, `saleCounter`), `RegisterSession` (open/close cash reconciliation + embedded `cashAdjustments[]`), `Sale` (embedded `items[]` with per-line `refundedQty`, `status` enum completed/held/refunded/voided/partially_refunded, `idempotencyKey`), `StoreLocation` (multi-branch), `PosAuditLog`. `EntitlementsService` gates `addEmployee`/`createLocation` against the seller's platform plan (staff-seat/location limits).

**Cross-cutting finding**: the shared `IdempotencyInterceptor` (`common/`) is applied **only** to `subscriptions`/`platform-plans` controllers — Cart/Checkout/Orders/Payment have **no idempotency protection at all** (a retried `place-order` call is not deduplicated against `checkoutId`); POS has its own separate hand-rolled mechanism.

---

### 5.4 Finance & Billing — `finance/`, `admin-finance/`, `subscriptions/`, `platform-plans/`, `platform-subscriptions/`, `seller/`

**⚠️ Key architectural finding: three parallel billing systems exist.**

1. **`subscriptions/`** — buyer ↔ seller: a store's own customers subscribe to *that store's* VIP/membership plans. Richest feature set, actively developed.
2. **`platform-plans/`** — seller ↔ Solvexo, **v2, current/canonical**: DB-driven `PlatformPlan` documents (admin CRUD via API), the entitlement system every other module actually reads (`EntitlementsService`), has AI credits, add-ons, trials, full Stripe webhook integration.
3. **`platform-subscriptions/`** — seller ↔ Solvexo, **v1/legacy**: hardcoded tier config in a TypeScript file (`config/platform-plan-tiers.config.ts`, comment: *"No admin UI exists to edit these yet... backend-defined config for v1, not a DB table"*), but **still fully wired into `app.module.ts` with live routes**, and has its **own independent** product-limit enforcement (`getProductLimitForStore`) that `ProductsService` can call **separately from** `EntitlementsService.assertCanCreateProduct`. Both `PlatformSubscription` (this module) and `SellerPlatformSubscription` (platform-plans) can exist per store simultaneously with **no reconciliation between them** — a real duplication/drift risk depending on which system a given feature check queries. **Do not delete either without a deliberate migration plan.**

#### `finance/` — `FinanceController` (`api/finance`, class `@Roles('seller')`) — 16 endpoints
Single ledger-writing surface in the platform (`FinanceService`) — also exposes an entire admin surface (`adminGetSellerFinancialDetails`, `adminApprovePayout`, etc.) called exclusively by `AdminFinanceService`, never routed through `FinanceController` itself, so ledger logic exists exactly once.
- `recordSale` — platform fee resolved **per-store** via `EntitlementsService.getTransactionFeeRate(storeId)` (this is the literal incentive to upgrade platform tier: 3%→1%→0.5%→0%); `PLATFORM_FEE_RATE = 0.08` only a fallback for stores with no plan record. Processing fee flat `2.9% + $0.30`. Net goes to `pendingBalance` for `CLEARING_DAYS = 3`.
- `recordRefund` — deducts available balance first, then pending; **platform commission is never clawed back on refund** (seller absorbs the full refund).
- `processClearingBalances()` — promotes pending sale transactions past `CLEARING_DAYS` to available balance; was previously dead code (constant existed, nothing invoked it) — now run hourly by `SchedulerService` + manually triggerable by admin.
- **No live payout-processor integration** — `adminApprovePayout` only records that an admin manually sent money elsewhere (their own bank/PayPal/Stripe dashboard); it doesn't move money itself.

**Schemas**: `SellerBalance` (available/pending/lifetime totals, unique per store), `Transaction` (ledger entries: sale/payout/fee/refund/adjustment), `Payout`, `PayoutMethod` (only last-4 of account number stored), `PayoutSchedule`, `TaxReport`.

#### `admin-finance/` — `AdminFinanceController` (`api/admin/finance`, `@Roles('admin')`) — 18 endpoints
Read-heavy aggregation (overview, revenue/commission trends, seller-balance listing, refund/tax/settlement/monthly reports, CSV/PDF export) + thin delegation to `FinanceService` for anything mutating (never duplicates ledger logic). `getOverview` uses shared `common/platform-earnings.util.ts` to combine order-commission + subscription-revenue into one "platform earnings" figure. Results cached in Redis (10 min TTL).

#### `platform-plans/` — 3 controllers, all under `api/platform-plans` — 18 endpoints total
`PlatformAddonsController` (4), `PlatformPlansController` (8), `SellerPlatformSubscriptionsController` (6). Controller registration order matters (static routes before `:storeId`/`:id`).
- **`PlatformPlansService`** — admin CRUD + public pricing-page browse; `adminArchivePlan` blocks archiving a plan with active subscribers unless `force=true`.
- **`SellerPlatformSubscriptionsService`** — billing engine, same proration math as buyer subscriptions: unused-time credit + existing `creditBalanceUSD` netted against new plan price; moving to a free plan **forfeits** remaining credit. `applyDunningFailure` — after `MAX_RENEWAL_ATTEMPTS=3`, a store is **demoted to the free plan, never fully canceled** (a store must always be on *some* tier — differs from buyer subscriptions, which do fully cancel).
- **`EntitlementsService`** — the central "what can this store do" resolver read by Store/Products/POS/Loyalty for feature gates and limits; falls back to `FALLBACK_LIMITS` only if no subscription **and** no free plan exist yet.
- **`AiCreditsService`** — grant/deduct/reset ledger; explicitly documented as **infrastructure with no consuming feature built yet**.
- **`PlatformAddonsService`** — flat hardcoded `ADDON_PRICING` table (extra AI credits, extra staff seat, priority marketplace placement, advanced tax compliance, SMS notifications) — deliberately not DB-driven.

**Schemas**: `PlatformPlan` (embedded `limits` object: maxProducts/maxStaffAccounts/maxPosLocations/aiCreditsPerMonth/transactionFeeRate/customDomainAllowed/whiteLabelAllowed/loyaltyProgramAllowed/subscriptionProductsAllowed/advancedAnalyticsAllowed/etc.), `SellerPlatformSubscription` (unique per store), `PlatformPlanInvoice`, `PlatformPlanPaymentAttempt`, `PlatformAddonPurchase`, `AiCreditsWallet`.

#### `platform-subscriptions/` — `PlatformSubscriptionsController` (`api/platform-subscriptions`) — 9 endpoints
See ⚠️ finding above. `getProductLimitForStore()` — the second, independent product-limit mechanism. `PosAddon` ($29/mo) is an embedded sub-schema on `PlatformSubscription`, not its own collection.

#### `subscriptions/` — buyer-facing VIP plans, largest service in the codebase (`SubscriptionsService`, 2064 lines)
`SubscriptionsController` (45 endpoints: buyer/admin/seller mixed) + `StripeWebhookController` (1 endpoint, no auth guard — trust via HMAC signature verification, `@SkipThrottle()`).
- `platformCommissionRate` (env `SUBSCRIPTION_PLATFORM_COMMISSION_RATE`, default 0.20) — previously subscription revenue had **no seller payout at all** (100% retained by platform); now fixed via `creditSellerPayout`.
- `subscribe()` — atomic insert via partial unique index on `{customerId, planId}` (active/paused only) replacing a prior race-prone check-then-create.
- `changePlan()` — computes proration itself even for Stripe-backed subs (rather than delegating to Stripe's native proration) so `creditBalanceUSD` stays comparable across both providers.
- `processRenewals()` — only processes `paymentProvider:'manual'` subs; Stripe-backed ones are reconciled reactively via webhook instead.
- Webhook handlers (`@OnEvent`) — `handleStripeInvoicePaymentSucceeded/Failed`, `handleStripeSubscriptionUpdated/Deleted`, `handleStripePaymentIntentSucceeded/Failed`.
- `queueEmail()` — routes notifications through BullMQ, falls back to inline send if the queue is unavailable (a billing-critical email is never silently dropped).

**Schemas**: `Subscription`, `SubscriptionPlan` (embedded `benefits[]` — 7 types: discount/shipping/early_access/loyalty_multiplier/credits/priority_support/priority_booking), `SubscriptionInvoice`, `SubscriptionPaymentAttempt`, `SubscriptionCreditWallet`, `SubscriptionNotificationPreference`, `SubscriptionCounter`, `WebhookEvent` (dedupe/replay tracking for every Stripe event received).

`SubscriptionBenefitsService` — resolves actual subscriber perks (discount precedence: product > category > store-wide; shipping waivers; loyalty multiplier; early-access hours). Consumed by Store/Products/Checkout/Orders. `CurrencyDisplayService` — **cosmetic-only** USD→PKR display conversion, never used for real billing math.

#### `seller/` — schema only
`Seller` schema (no controller/service in this directory): `stripeCustomerId` explicitly documented as **separate** from any `User.stripeCustomerId` the same person might have as a buyer.

---

### 5.5 Growth & Engagement — `marketing/`, `loyalty/`, `messaging/`, `rating/`, `address/`, `analytics/`, `admin-analytics/`

#### `marketing/` — `MarketingController` (`api/marketing`, `@Roles('seller')`) — 4 endpoints
Per-store discount coupons (percentage/fixed). **Gap**: `usageCount`/`usageLimit` fields exist on the schema but nothing anywhere increments `usageCount` or enforces `usageLimit` — coupon redemption enforcement is not implemented.

#### `loyalty/` — `LoyaltyController` (`api/loyalty`) — 15 endpoints, `@Global()` module
Points/tiers/rewards program. `LoyaltyService.awardPoints()` is the single entry point for every point change (earn types recompute tier + lifetime points; non-earn types only move balance). `awardReviewPoints` called by `RatingService`; `awardPurchasePoints`/`clawbackPurchasePoints` called by `OrdersService`. `redeemReward` — atomic conditional deduct + stock decrement, **compensates by refunding points if stock ran out after points were already deducted** (no Mongo transaction — a recurring compensating-action pattern in this codebase). Buyer-facing routes (`rewards`, `my-balance`, `redeem`) have no `@Roles()` — technically callable by any authenticated role.

#### `messaging/` — `MessagingController` (`api/messaging`) — 22 endpoints + `MessagingGateway`
Buyer↔seller chat. `sendMessage` auto-snapshots product details for `product_share` type, computes a crude URL-density `spamScore`. `Conversation.isPriority` set from a subscriber's `priority_support` benefit (affects seller inbox sort order). Block/report moderation + full admin oversight routes.

`MessagingGateway` (namespace `/messaging`) — JWT-verified on handshake (own `jwtService.verify`, same pattern as ActivityLogGateway); presence tracking via in-memory `onlineCounts` map; events: client `join-conversation`/`leave-conversation`/`typing`/`presence:check`, server `message:new`/`edited`/`deleted`/`seen`, `conversation:update` (pushed to `user:{id}` room for inbox reordering without opening the thread), `presence:{userId}`.

#### `rating/` — `RatingController` (`api/rating`) — 12 endpoints
`checkVerifiedPurchase` scans the user's orders in application code (not a single targeted query — explicit design choice noted in comments about array cross-matching risk; potential perf concern for high-order-count users). `addReview` fires `LoyaltyService.awardReviewPoints` fire-and-forget (`.catch(()=>{})`) only if verified+rated. `recalcProductRating` does a full aggregate recompute rather than incremental updates (avoids drift). No WebSocket gateway (pull-based).

#### `address/` — `AddressController` (bare `address` prefix — breaks the `api/...` convention) — 7 endpoints
**Security gaps**: `getAddressById` and `updateAddress` have **no ownership check** — any authenticated user can fetch/update any address by ID (only `deleteAddress`/`setDefaultAddress`'s initial unset are ownership-filtered). `CreateAddressDto`/`UpdateAddressDto` use field names (`fullName`/`phone`) that **don't match the actual schema** (`recipientName`/`phoneNumber`) — moot today only because the controller ignores the DTOs and uses `body: any` instead.

#### `analytics/` (seller) & `admin-analytics/` (platform-wide)
Share the **exact same aggregation core** (`analytics/utils/order-aggregation.util.ts`, `analytics-date.util.ts`, `analytics-cache.util.ts`, `csv.util.ts`, `pdf-report.util.ts`) — every function accepts an optional `scopeMatch` so seller-scoped and platform-wide analytics reuse identical logic; `admin-finance` also shares the `platform-earnings.util.ts` piece. Both cache compute results in Redis (10 min TTL, `withAnalyticsCache`, degrades gracefully if Redis is down). Documented data-model gaps affecting both: **no COGS/cost field** (blocks profit-margin sorting), **no search/page-view tracking** (blocks true funnel analysis — signup→first-order conversion is the only computable funnel step).
- `analytics` (`api/seller/analytics`, `@Roles('seller')`) — 11 endpoints: overview, revenue/orders-over-time, traffic-sources, top-products, customers, product-performance, inventory-insights (fixed 30-day window, no `range` param), payment-methods, revenue-breakdown (order revenue vs. subscription revenue — subscription plans are **seller-scoped not store-scoped**, so a multi-store seller sees identical recurring-revenue on every store), export (CSV/PDF).
- `admin-analytics` (`api/admin/analytics`, `@Roles('admin')`) — 16 endpoints: same shape platform-wide plus seller rankings/performance, seller registration trends, category rollups, platform-metrics (funnel), export.

---

### 5.6 Infrastructure & Shared — `common/`, `database/`, `redis/`, `queues/`, `scheduler/`, `upload/`, `firebase/`, `health/`

#### `common/` — 5 files
- **`IdempotencyInterceptor`** — keyed off `Idempotency-Key` header (no-op if absent); composite key `requesterId:method:route:rawKey`; states `in_progress`→`completed`, replays the cached response body on retry, 409s a genuinely concurrent duplicate, deletes the record on handler failure so retry is possible. 24h TTL enforced by a Mongo TTL index on `IdempotencyRecord.expiresAt`. **Only wired into `subscriptions`/`platform-plans` controllers.**
- **`number.util.ts`** — `round(n)` = `Math.round(n*100)/100`, the shared 2-decimal money convention.
- **`platform-earnings.util.ts`** — `getPlatformEarnings()`: `commission + processingFees` from `Transaction` (type sale, not failed) + `subscriptionRevenue` (100% platform, seller-scoped only — no storeId filter applies here) from `SubscriptionInvoice`; `total = round(commission + subscriptionRevenue)` (processingFees tracked separately, not folded into total). Shared by `AdminAnalyticsService` and `AdminFinanceService`.
- **`store-ownership.util.ts`** — 3 deliberately-distinct ownership checks (kept separate to avoid changing existing endpoints' response codes): `verifyStoreOwnershipOrForbidden` (single query, 403 either way), `verifyStoreOwnershipStrict` (404 if missing, 403 if mismatched), `verifyStoreExists` (existence-only, for admin code).

#### `database/`
`MONGO_URI` env var, no explicit pool/retry config (Mongoose defaults). ~59 schemas registered once via `database.module.ts` + `schema.ts` barrel. See §3 for the `DatabaseService.repositories` pattern and the dormant `otpModel` copy-paste bug.

#### `redis/`
Client: `redis` npm package, `REDIS_URL` env var (default `redis://localhost:6379`), connects best-effort (logs a warning and continues if unreachable — never crashes the app; every method no-ops when disconnected). Two concrete uses observed: (1) OTP/session-liveness KV checks (`JwtAuthGuard`'s session check, analytics cache), (2) **distributed locking** — `acquireLock`/`releaseLock` (Lua compare-and-delete)/`withLock` — the exact primitive `SchedulerService.runLocked()` wraps every cron job in. No evidence of Redis-backed HTTP caching beyond the analytics 10-min cache, and rate limiting (`@nestjs/throttler`) is in-memory, not Redis-backed.

#### `queues/` — 2 BullMQ queues, `@Global()` module
`REDIS_URL`-backed shared connection (`maxRetriesPerRequest: null`, required by BullMQ). `stripe-webhooks` (6 attempts, exponential backoff from 5s, failed jobs kept visible as dead-letter). `subscription-emails` (4 attempts, exponential backoff from 10s). Rationale: Stripe expects ~10s webhook ack; synchronous DB work risks timeout→redelivery with partial side effects, so the webhook controller only verifies+persists+enqueues and returns 200 immediately.

**Processors**:
- `StripeWebhookProcessor` — re-fetches the canonical event from Stripe (`stripe.events.retrieve`) rather than trusting the stored payload snapshot; fans out via `EventEmitter2.emitAsync('stripe.<type>', object)` for 6 routed event types; deliberately does **not** import either billing service directly (avoids a dependency cycle) — both `SubscriptionsService` and `SellerPlatformSubscriptionsService` independently `@OnEvent`-listen and no-op if the event isn't theirs. This is how one webhook endpoint serves two independent billing systems.
- `SubscriptionEmailProcessor` — looks up a method name on `SubscriptionNotificationsService` and invokes it; unknown kind → logs and drops rather than throwing.

Note: `platform-plans`/`platform-subscriptions` billing services send email **synchronously**, not via queue — only the buyer-facing `subscriptions` module routes emails through BullMQ.

#### `scheduler/` — 13 cron jobs, `scheduler.service.ts`
`runLocked(jobName, ttlMs, fn)` wraps a job body in `redis.withLock('cron-lock:'+jobName, ...)` so horizontally-scaled instances don't duplicate work; skips (logs debug) if the lock isn't acquired.

| # | Schedule | Method | Purpose |
|---|---|---|---|
| 1 | every minute | `activateScheduledProducts` | Flips `scheduled`→`active` products past `scheduledAt` |
| 2 | daily 02:00 | `expireLoyaltyPoints` | `LoyaltyService.expireInactivePoints()` |
| 3 | hourly | `runSubscriptionRenewals` | Buyer VIP manual-provider renewals + dunning |
| 4 | daily 02:30 | `finalizeSubscriptionCancellations` | Finalizes buyer "cancel at period end" |
| 5 | every 6h | `sendSubscriptionReminders` | Buyer renewal/past-due reminder emails |
| 6 | hourly | `runPlatformSubscriptionRenewals` | Legacy (v1) platform-tier renewals — **not** wrapped in `runLocked` |
| 7 | daily 02:30 | `finalizePlatformCancellations` | Legacy (v1) downgrade-at-period-end — **not** wrapped in `runLocked` |
| 8 | hourly :15 | `processFinanceClearingBalances` | `FinanceService.processClearingBalances()` |
| 9 | hourly :05 | `runPlatformPlanRenewals` | v2 platform-plan renewals |
| 10 | daily 02:45 | `expirePlatformPlanTrials` | v2 trial expiry → free plan |
| 11 | daily 09:00 | `sendPlatformPlanTrialReminders` | v2 "trial ends soon" emails |
| 12 | monthly (1st, 03:00) | `resetAiCreditsMonthly` | Resets every store's AI-credit balance |
| 13 | hourly :20 | `runAddonRenewals` | Recurring add-on charges |

⚠️ Jobs #6/#7 are the only two **not** protected by the distributed lock — a real duplicate-execution risk on scaled deployments, worth fixing opportunistically.

#### `upload/`
Cloudinary-backed (not S3/local-disk/Firebase). `api/upload/file` (public assets, `memoryStorage`, 100MB) and `api/upload/private-file` (`@Roles('seller')`, 500MB, digital products for sale — `type:'private'`, returns only `publicId`+metadata, no direct URL). `generateSignedUrl`/`downloadPrivatePdfBuffer` for time-limited private access. `stampPdf` — watermarks every page of a sold digital PDF with the buyer's email + order number (licensing/anti-piracy), using `pdf-lib`. `multer.config.ts`'s `createMulterOptions` (Cloudinary storage, 5MB limit) appears to be dead/unused — the actual controller uses inline `memoryStorage()` instead.

#### `firebase/` — **completely dead**
`firebase.module.ts` is a 0-byte file, not wired into `app.module.ts` at all. `firebase.config.ts`'s entire `FirebaseAdminService` (FCM push) is commented out. Client-side plumbing exists (`fcmToken` fields on User/Seller/Admin, accepted in DTOs) but **no code path anywhere sends a push notification**. This is scaffolding for a not-yet-built feature.

#### `health/` — `HealthController` (`health`, hidden from Swagger, exempt from throttling)
`GET health/live` — pure liveness, no dependency checks. `GET health/ready` — Terminus `@HealthCheck()`: MongoDB ping (`mongoose.pingCheck`) + Redis connection-state read (not an active ping).

---

### 5.7 SEO — `seo/` (Admin/Platform SEO + Seller/Store SEO)

Added 2026-07-14 per a dedicated architecture plan (11 phases). Single top-level module (`SeoModule`, not split into sub-modules — everything shares `DatabaseService` + the same guard imports, same pattern as why `platform-plans/` isn't split either). 23 controllers, 14 services (+5 provider-adapter classes not separately DI-registered as top-level services), 13 schemas (+3 embedded extensions on `Product`/`Category`/`Store`), 79 endpoints, 3 new BullMQ queues, 5 new cron jobs, 4 new `PlatformPlan.limits` flags.

**Design principle carried through every piece**: management (setting meta fields) and delivery (getting those fields in front of Google/Facebook/Twitter) are two different problems — the module has a dedicated meta-delivery layer (`SeoResolutionService` + public render routes) rather than only exposing CRUD.

#### Foundations
- **`Product.seo` / `Category.seo`** — embedded `SeoMeta` sub-document (`seo/schemas/seo-meta.schema.ts`): `metaTitle`, `metaDescription`, `ogImage`, `ogTitle`, `ogDescription`, `twitterCard`, `canonicalUrlOverride`, `noindex`, `keywords[]`, `aiGenerated`, `updatedAt`. Embedded directly (not a side collection) — zero extra queries on the highest-traffic public read path.
- **`Store.seo`** — its own `StoreSeo` sub-document (`store/schemas/store.schema.ts`, superset of `SeoMeta` — duplicated fields rather than inherited, deliberately, to avoid Mongoose subdocument-inheritance footguns) plus `checklist[]` (Technical Checklist) and `pages: Record<pageId, {...}>` (page-builder page meta).
- **`Faq.seo`** — same embedded shape, added for Help Center SEO (no Blog module exists yet in this backend, so "Blog SEO" is deferred until one does).
- **`common/seo-token-encryption.util.ts`** — AES-256-GCM encrypt/decrypt for OAuth refresh tokens on `SeoIntegration` — the first secret-encrypted-at-rest capability in this codebase (Stripe's key is a plain env var; nothing else encrypts per-record secrets). Requires `SEO_TOKEN_ENCRYPTION_KEY` env var.
- **4 new `PlatformPlan.limits` flags** (wired into the schema default, `EntitlementsService`'s `PlatformPlanLimits`/`FALLBACK_LIMITS`/`BOOLEAN_FEATURES`, and `PlatformPlanLimitsDto` so admins can actually set them via the API): `advancedSeoToolsAllowed` (Audit/Score/Checklist), `seoAiSuggestionsAllowed` (AI suggestions), `searchConsoleIntegrationAllowed` (per-store GSC/Bing), `customRedirectsAllowed` (seller redirect/canonical management).
- **`'seo'` added to `ACTIVITY_LOG_CATEGORIES`** — every SEO write logs through the existing `ActivityLogService`.

#### Meta-delivery layer (the critical, previously-missing piece)
- **`SeoResolutionService`** — given `(entityType, entityId)`, walks the fallback chain entity override → category → store → global token-templated default (`PlatformSeoSettings.metaTemplates`), returns fully-resolved title/description/canonical/robots/OG/Twitter/JSON-LD. Redis-cached 10 min (`seo:meta:{entityType}:{entityId}`), explicitly invalidated (not just TTL) by every write path.
- **`SeoSchemaGeneratorService`** — pure, stateless JSON-LD builder (Product/Store/Organization/Website/SearchAction/BreadcrumbList).
- **Public routes** (`seo/public/`, no auth): `GET /api/seo/meta/:entityType/:entityId` (JSON, for the React SPA to consume client-side) and `GET /seo-render/:entityType/:slug` (minimal server-rendered HTML fragment with real `<title>`/meta/JSON-LD tags — intended to be served to bot user-agents via a reverse-proxy "dynamic rendering" rule, since a client-side-rendered SPA can't otherwise produce correct Open Graph previews for Facebook/Twitter/LinkedIn crawlers, which don't execute JS).

#### Admin / Platform SEO
- **`PlatformSeoSettings`** (singleton, `key:'global'`) — homepage/marketplace meta, `metaTemplates[]`, `robotsTxtBody`, `organizationSchema`/`websiteSchema`/`searchActionSchema`, `aiSeoEnabled` (platform-wide kill switch), `rules[]` (audit-check thresholds — see Refinement below).
- `PlatformSeoController` (`api/admin/seo`) — settings + rules CRUD. `AdminSeoCategoryController`/`AdminSeoFaqController` — category/FAQ meta override (root categories are admin-curated anyway). `SeoLandingPagesController` (`SeoLandingPage` collection — admin-authored marketing pages).
- **Sitemap**: `SeoSitemapService` generates **chunked** XML (`SeoSitemapCache`, capped at 45k URLs/chunk per the sitemap protocol's 50k limit) via the `seo-sitemap` queue (never inline). Public: `GET /sitemap.xml` (index), `GET /sitemap-:suffix.xml` (chunks). Admin: `AdminSeoSitemapController` (status/regenerate).
- **Redirects/Canonical**: `SeoRedirect`/`SeoCanonicalRule` collections shared between admin (`storeId:null`) and seller (`storeId` set) via one `SeoRedirectsService`/`SeoCanonicalService` — same "one shared service, two scoped controllers" pattern as `analytics`/`admin-analytics`. Destination URLs validated same-origin-or-allowlisted (`seo-url-safety.util.ts`) against open-redirect abuse.
- **Search integrations** (`SeoIntegration` collection, `scope:'platform'|'store'`): strategy/adapter pattern mirroring `subscriptions/payment-gateway/` — `ISeoSearchProvider` interface + `GoogleSearchConsoleProvider`/`GoogleAnalyticsProvider`/`GoogleMerchantCenterProvider` (share OAuth via `GoogleOAuthProviderBase`) + `BingWebmasterProvider` (API-key auth, not OAuth — adapts the same interface shape). `SeoIntegrationsService` is a thin orchestrator owning token encryption + the `status` state machine (`connected|syncing|error|needs_reauth|disconnected`) exactly once. `AdminSeoIntegrationsController` (connect/disconnect/sync). Requires `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` env vars (Bing needs no app registration, just a per-integration API key pasted by the admin/seller).
- **Monitoring**: `SeoCrawlLog` (bot-hit log, **buffered in-memory and flushed via `insertMany` every ~10s** — never a write per request, since external crawler traffic isn't rate-controllable), `SeoIndexSnapshot` (GSC/Bing coverage), `SeoCoreWebVitalsSnapshot` (PageSpeed Insights API, `PAGESPEED_INSIGHTS_API_KEY` env var). `SeoMonitoringService` owns all three + the crawl-tracking middleware registered in `main.ts`. `AdminSeoMonitoringController`.
- **Analytics**: `SeoAnalyticsSnapshot` (one row per scope/provider/date — clicks/impressions/ctr/avgPosition from GSC/Bing, `organicSessions` from GA4). `SeoAdminAnalyticsService` reads it, scope-parameterized so admin (`platform`) and seller (`store`) share the exact same read logic — same shape as `analytics`/`admin-analytics`. `AdminSeoAnalyticsController`.

#### Seller / Store SEO
- `SellerStoreSeoController` (`api/store/:storeId/seo`) — dashboard (completeness + checklist rollup), store meta get/update, Technical Checklist (automated items derived at read time — `meta_title_set`, `has_custom_domain`, etc. — merged with 3 manual seller-ticked items).
- `SellerProductSeoController` — product SEO list (with a 0-100 completeness heuristic)/get/update, **bulk-apply-template** (token-templated title/description across many products by filter — real value at catalog scale) and **CSV export** (reuses `analytics/utils/csv.util.ts`'s `toCsv`, same convention as Finance/Analytics exports).
- `SellerContentSeoController` — read-only category view (categories are platform-owned) + page-builder page meta CRUD.
- `SellerSeoPreviewController` — schema/social preview, thin wrapper around `SeoResolutionService.resolve()` scoped to the seller's own entities.
- **AI SEO**: `SeoAiSuggestionLog` collection. `ISeoAiProvider` interface + `AnthropicSeoAiProvider` (Claude, model `claude-opus-4-8`, structured outputs via `output_config.format` — added `@anthropic-ai/sdk` as a real declared dependency, not borrowed from another package's transitive install). `SeoAiService` verifies ownership + `seoAiSuggestionsAllowed` + the platform AI-SEO kill switch, deducts `AiCreditsWallet` credits (`AI_SEO_SUGGESTION_CREDIT_COST = 5`, via the existing-but-previously-unconsumed `AiCreditsService.deduct` — this is its first real consumer), calls the provider, writes the result via `SeoContentService.applySeoSuggestion`. `SellerSeoAiController` — single generate (idempotency-protected + throttled, since it costs real credits/API spend), bulk generate (queued via `seo-ai`, `SeoAiProcessor` processes one at a time and stops early on insufficient-credit failure, reporting partial success), suggestion history.
- **Audit + Score**: `SeoAuditResult` collection. `SeoAuditService` runs a **fixed, code-defined set of checks** (`title_length`, `description_length`, `missing_alt_text`, `thin_content`, `duplicate_meta`, `missing_canonical`, `broken_internal_link`, `missing_schema`) whose *thresholds* (not logic) come from `PlatformSeoSettings.rules` — deliberately not a generic rule engine (would be over-engineering; nobody but the platform admin ever adds a new check type, and that needs code anyway). Some checks are honest approximations of what this data model can actually support (e.g. `missing_alt_text` — no per-image alt-text field exists in `Product`, so it flags products with zero images instead). Score = weighted blend of issue-severity deductions (80%) + checklist completion (20%). Runs via the `seo-audit` queue (never inline — may call external PSI/CWV APIs). `SellerSeoAuditController` (run/latest/history), gated by `advancedSeoToolsAllowed`.
- **Seller integrations + analytics**: `SellerSeoIntegrationsController`/`SellerSeoAnalyticsController` — same shared `SeoIntegrationsService`/`SeoAdminAnalyticsService` as admin, scoped by `storeId`, gated by `searchConsoleIntegrationAllowed`.

#### Queues & cron (added to the shared infra, not a separate system)
`queue.constants.ts`/`queue.module.ts` gained 3 entries: `seo-sitemap` (3 attempts), `seo-audit` (3 attempts, external-API latency), `seo-ai` (2 attempts — deliberately fewer, since retrying a credit-consuming call many times on failure is undesirable). `scheduler.service.ts` gained 5 jobs, all wrapped in the existing `runLocked` Redis-lock pattern: `regenerateSitemaps` (daily 04:00), `syncSearchConsoleData` (daily 01:00), `syncGoogleAnalyticsData` (daily 01:30), `refreshCoreWebVitals` (weekly, Sun 03:00, capped to top ~40 URLs), `runScheduledSeoAudits` (daily 05:00, only for stores whose plan includes `advancedSeoToolsAllowed`).

#### Known gaps / follow-ups (parity with how this document flags dead/incomplete code elsewhere)
- **External credentials not yet provisioned** — GSC/GA4/Merchant Center need a real Google Cloud OAuth client (`GOOGLE_OAUTH_CLIENT_ID`/`SECRET`); Bing needs an admin/seller-supplied API key; `PAGESPEED_INSIGHTS_API_KEY` for Core Web Vitals; `SEO_TOKEN_ENCRYPTION_KEY` for credential encryption; `ANTHROPIC_API_KEY` (or an `ant auth login` profile) for AI SEO. Until these are set, the corresponding features are structurally complete but non-functional — same status Stripe/Cloudinary integration code would have with no API key configured.
- **Merchant Center has no click/impression data** — that requires the separate Merchant Center Reports API, explicitly out of scope for this pass; product-listing performance comes from GSC/GA4 instead.
- **Collections SEO / Blog SEO** — deferred; no Collections or Blog module exists yet in this backend. The same embedded-`SeoMeta` pattern applies the moment either ships.
- **Existing `PlatformPlan` documents in the DB** won't have the 4 new `limits` flags populated until an admin edits them via the API (Mongoose schema defaults only apply to newly-created documents) — they'll read as `undefined`/falsy, i.e. **fail closed** (feature blocked) until explicitly enabled per plan. This is the same no-migration schema-evolution pattern already used elsewhere in this codebase (e.g. `Address.country` falling back to "unknown" for pre-existing rows).

---

## 6. Database Tables & Relationships

All relationships below are **plain string fields**, not Mongoose `ref`s — no `.populate()` is used anywhere in this codebase. "Relates to" describes the application-level join every service performs manually.

| Collection | Module | Key relations |
|---|---|---|
| `users` | users | — |
| `admins` | admin | — |
| `sellers` (seller schema, collection name per Mongoose default) | seller | `storeId` → Store (informal) |
| `activitylogs` | activity-log | `storeId`→Store (or sentinel `'platform'`), `actorId`/`targetId`→ any account |
| `stores` | store | `sellerId`→Seller, `categoryId`→Category (root only) |
| `storefollowers` | store | `userId`→User, `storeId`→Store |
| `products` | products | `sellerId`→Seller, `storeId`→Store, `categoryId`/`subCategoryId`→Category |
| `productvariants` | products | `productId`→Product |
| `categorys`/`categories` | categories | `parentId`→Category (self, 1 level only) |
| `banners` | banner | — |
| `faqs` | faqs | — |
| `cart` | cart | `userId`→User, items ref Product/ProductVariant |
| `wishlist` (`wishList`) | cart | `userId`, `productId`, `productVariantId` |
| `checkout` | checkout | `userId`→User, `addressId`→Address, items snapshot sellerId/storeId/productId |
| `shippingzones` | checkout | — |
| `orders` | orders | `userId`→User, `checkoutId`→Checkout, `sellerOrders[].storeId/sellerId` |
| `userpaymentmethods` | payment | `userId`→User (dead — never read/written) |
| `paymenttransactions` | payment | `userId`, `checkoutId`, `orderIds[]`→Order |
| `employees` | pos | `storeId`, `sellerId`, `locationId`→StoreLocation |
| `possettings` | pos | `storeId` (unique) |
| `registersessions` | pos | `storeId`, `registerId`→Store.registers[], `employeeId`, `shiftId`→Store.shifts[] |
| `sales` | pos | `storeId`, `sessionId`→RegisterSession, `registerId`, `locationId`, `employeeId` |
| `storelocations` | pos | `storeId`, `sellerId` |
| `posauditlogs` | pos | `storeId`, `employeeId` |
| `sellerbalances` | finance | `storeId` (unique), `sellerId` |
| `transactions` | finance | `storeId`, `sellerId`, `referenceId`→Order/Payout/manual/subscription_invoice/platform_plan_invoice |
| `payouts` | finance | `storeId`, `sellerId`, `payoutMethodId` |
| `payoutmethods` | finance | `storeId`, `sellerId` |
| `payoutschedules` | finance | `storeId` (unique) |
| `taxreports` | finance | `storeId`, `sellerId` |
| `platformplans` | platform-plans | — |
| `sellerplatformsubscriptions` | platform-plans | `storeId` (unique), `sellerId`, `platformPlanId`→PlatformPlan |
| `platformplaninvoices` | platform-plans | `storeId`, `sellerId`, `platformPlanId` |
| `platformplanpaymentattempts` | platform-plans | `storeId`, `sellerId`, `invoiceId` |
| `platformaddonpurchases` | platform-plans | `storeId`, `sellerId` |
| `aicreditswallets` | platform-plans | `storeId` (unique), `sellerId` |
| `platformsubscriptions` | platform-subscriptions | `storeId` (unique), `sellerId` |
| `subscriptions` | subscriptions | `planId`→SubscriptionPlan, `customerId`→User, `storeId`, `sellerId` |
| `subscriptionplans` | subscriptions | `sellerId`, `storeId` |
| `subscriptioninvoices` | subscriptions | `subscriptionId`, `storeId`, `sellerId`, `customerId` |
| `subscriptionpaymentattempts` | subscriptions | `subscriptionId`, `storeId`, `sellerId`, `customerId` |
| `subscriptioncreditwallets` | subscriptions | `customerId`, `storeId`, `subscriptionId` |
| `subscriptionnotificationpreferences` | subscriptions | `customerId` (unique) |
| `subscriptioncounters` | subscriptions | — (invoice-number sequence) |
| `webhookevents` | subscriptions | `providerEventId` (unique) — dedupe/replay for Stripe events |
| `coupons` | marketing | `storeId`, `sellerId` |
| `loyaltymembers` | loyalty | `storeId`, `userId` (unique compound) |
| `loyaltyprograms` | loyalty | `storeId` (unique) |
| `loyaltytransactions` | loyalty | `storeId`, `memberId`, `userId`, `orderId` |
| `rewards` | loyalty | `storeId`, `productId`→Product (informal) |
| `conversations` | messaging | `buyerId`→User, `storeId`, `sellerId` (unique compound buyer+store) |
| `messages` | messaging | `conversationId`→Conversation, `senderId` |
| `blocks` | messaging | `blockerId`, `targetId` |
| `reports` | messaging | `reporterId`, `targetId` |
| `ratings` | rating | `userId`, `productId`, `storeId`, `productVariantId`, `orderId` |
| `addresses` | address | `userId`→User |
| `idempotencykeys`/`idempotencyrecords` | common | `key` (unique) |
| `tokenblacklists` | auth | dead/unregistered |
| `otps` | otp | dead/unregistered (type-exported only) |
| `platformseosettings` | seo | singleton (`key:'global'`) |
| `seolandingpages` | seo | `slug` (unique) |
| `seoredirects` | seo | `storeId` (nullable — null=platform-wide) |
| `seocanonicalrules` | seo | `storeId` (nullable) |
| `seointegrations` | seo | `scope`+`storeId`+`provider` (unique compound) |
| `seositemapcaches` | seo | `type`+`storeId`+`chunkIndex` (unique compound) |
| `seocrawllogs` | seo | `storeId` (nullable), TTL-indexed 60-day retention |
| `seoindexsnapshots` | seo | `scope`+`storeId`+`provider`+`snapshotDate` |
| `seoanalyticssnapshots` | seo | `scope`+`storeId`+`provider`+`date` (unique compound) |
| `seocorewebvitalssnapshots` | seo | `url`, `storeId` (nullable) |
| `seoaisuggestionlogs` | seo | `storeId`, `sellerId`, `entityType`+`entityId` |
| `seoauditresults` | seo | `storeId`, `runAt` |

**Embedded (not their own collection)**: `Store.registers[]`, `Store.shifts[]`, `Order.sellerOrders[]`/`.items[]`, `Checkout.items[]`, `Cart.items[]`, `Sale.items[]`, `RegisterSession.cashAdjustments[]`, `LoyaltyProgram.tiers[]`, `SubscriptionPlan.benefits[]`, `PlatformSubscription.posAddon`, `Product.seo`/`Category.seo`/`Faq.seo` (`SeoMeta`), `Store.seo` (`StoreSeo`, incl. `.checklist[]`/`.pages{}`).

---

## 7. Authentication & Authorization

- **JWT-based**, `passport-jwt`. `JwtStrategy` verifies against `JWT_SECRET`, extracts `{userId, email, role}` onto `req.user`.
- **`JwtAuthGuard`** additionally requires the raw token to exist as a Redis key (a session-liveness/single-session check on top of JWT signature validity) — falls back to signature-only if Redis is unreachable.
- **`OptionalJwtAuthGuard`** — never blocks; used for endpoints that personalize responses for logged-in users without requiring login (e.g. public product/store browsing with subscriber pricing).
- **`RolesGuard` + `@Roles(...)`** — checks `req.user.role` against a flat list of allowed role **strings**. Only 3 roles exist platform-wide: `'user'` (buyer), `'seller'`, `'admin'`. **There is no granular permission/ACL system** — no per-action permissions, no staff sub-roles at the platform level (POS `Employee.role` — cashier/manager — is the one exception, but it's a POS-internal concept checked manually in `PosService`, not integrated with `RolesGuard`).
- Sessions are capped in practice by the **shorter of** the JWT's own expiry and the Redis key's TTL (these are inconsistently set across login/verifyOtp flows — see §5.1 quirks).
- No formal logout/token-revocation endpoint exists; the closest equivalent is the Redis session TTL expiring or a login overwriting the previous session's Redis key.
- Two WebSocket gateways (`ActivityLogGateway`, `MessagingGateway`) each do their **own independent** JWT verification on the socket handshake — they do not go through `JwtAuthGuard` and do not check Redis session liveness, so a socket connection can outlive an HTTP-invalidated session until the JWT itself expires.

---

## 8. Events & Listeners

**EventEmitter2 domain events** (registered via `EventEmitterModule.forRoot()` in `app.module.ts`), all Stripe-sourced, emitted by `StripeWebhookProcessor`:

| Event | Emitted from | Listened by |
|---|---|---|
| `stripe.invoice.payment_succeeded` | StripeWebhookProcessor | SubscriptionsService, SellerPlatformSubscriptionsService |
| `stripe.invoice.payment_failed` | StripeWebhookProcessor | SubscriptionsService, SellerPlatformSubscriptionsService |
| `stripe.customer.subscription.updated` | StripeWebhookProcessor | SubscriptionsService |
| `stripe.customer.subscription.deleted` | StripeWebhookProcessor | SubscriptionsService, SellerPlatformSubscriptionsService |
| `stripe.payment_intent.succeeded` | StripeWebhookProcessor | SubscriptionsService |
| `stripe.payment_intent.payment_failed` | StripeWebhookProcessor | SubscriptionsService |

Both billing services listen independently and no-op if the event's subscription/customer id isn't theirs — this is the deliberate mechanism by which one Stripe webhook endpoint serves two unrelated billing systems without a direct code dependency between them (avoids a circular import).

**Socket.IO gateway events**:

| Gateway | Namespace | Client→Server | Server→Client |
|---|---|---|---|
| `ActivityLogGateway` | `/activity-log` | `join-store`, `leave-store` | `activity:new`, `activity:joined`, `activity:error` |
| `MessagingGateway` | `/messaging` | `join-conversation`, `leave-conversation`, `typing`, `presence:check` | `message:new`, `message:edited`, `message:deleted`, `message:seen`, `conversation:update`, `presence:{userId}`, `messaging:joined`, `messaging:error` |

---

## 9. Queues

5 BullMQ queues, all backed by the shared Redis connection (`REDIS_URL`), registered `@Global()` in `queues/queue.module.ts`:

| Queue | Job | Attempts/Backoff | Processor | Purpose |
|---|---|---|---|---|
| `stripe-webhooks` | `process-stripe-event` | 6 attempts, exponential from 5s, failed jobs kept (`removeOnFail:false`) | `StripeWebhookProcessor` | Async Stripe webhook processing so the HTTP ack stays under Stripe's ~10s timeout |
| `subscription-emails` | `send-subscription-email` | 4 attempts, exponential from 10s | `SubscriptionEmailProcessor` | Buyer-subscription transactional emails (renewal/proration/cancellation) |
| `seo-sitemap` | `regenerate-sitemap` | 3 attempts, exponential from 15s | `SeoSitemapProcessor` | Chunked sitemap regeneration — can be slow at catalog scale, never runs inline |
| `seo-audit` | `run-audit` | 3 attempts, exponential from 10s | `SeoAuditProcessor` | Runs the fixed SEO audit checks; may call external PSI/CWV APIs with real latency |
| `seo-ai` | `generate-suggestion-bulk` | 2 attempts (deliberately few — credit-consuming), exponential from 5s | `SeoAiProcessor` | Bulk AI SEO suggestion generation; processes one entity at a time, stops early on insufficient-credit failure |

Platform-plan and legacy platform-subscription emails are sent **synchronously**, not via queue.

---

## 10. Cron Jobs

See full table in §5.6 (`scheduler/`) for the pre-SEO 13 and §5.7 for the 5 SEO jobs. 18 jobs total, 16 protected by a Redis distributed lock, 2 (`runPlatformSubscriptionRenewals`, `finalizePlatformCancellations`) currently unprotected — all 5 SEO jobs are protected.

---

## 11. Redis

Client: `redis` npm package (not `ioredis`). Env: `REDIS_URL` (default `redis://localhost:6379`). Connects best-effort at `onModuleInit` — never crashes the app if unreachable; every `RedisService` method becomes a safe no-op when disconnected, and dependent features degrade gracefully (JWT session check falls back to signature-only; analytics cache recomputes instead of serving cached).

**Concrete uses**: (1) session-liveness key for `JwtAuthGuard`, (2) analytics result caching (10-min TTL, `withAnalyticsCache`), (3) **distributed cron locks** (`acquireLock`/`releaseLock` via Lua compare-and-delete/`withLock`) — every scheduler job (except the 2 noted gaps) wraps its body in this. Also backs BullMQ (separate connection config in `queue.module.ts`, same `REDIS_URL`).

---

## 12. Stripe Integration

Provider abstraction: `IPaymentGateway` interface, selected via `PAYMENT_PROVIDER` env (`manual` default; `stripe` requires `STRIPE_SECRET_KEY`). `ManualPaymentProvider` simulates every call (always succeeds, fake ids) — this is what's active unless `PAYMENT_PROVIDER=stripe` is explicitly set. `StripePaymentProvider` is the real integration, used identically by both `subscriptions` (buyer VIP plans) and `platform-plans`/`platform-subscriptions` (seller billing).

**Stripe API surface used**: `customers.create` (idempotency-keyed), `products.create`+`prices.create` (idempotency-keyed, prices treated as immutable once cached), `subscriptions.create` (`payment_behavior:'default_incomplete'`, returns PaymentIntent client_secret for 3DS), `customers.retrieve`+`paymentIntents.create` (`off_session:true,confirm:true` — proration top-ups/manual charges), `subscriptions.cancel`, `setupIntents.create` (add-card flow), `billingPortal.sessions.create`, `checkout.sessions.create` (defined, **never actually invoked** — dead code kept for future hosted-checkout use), `refunds.create`, `subscriptions.retrieve`+`subscriptions.update` (`proration_behavior:'none'` always — this codebase computes proration itself, never delegates to Stripe's).

**Webhook events handled**: `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `payment_intent.succeeded`, `payment_intent.payment_failed` (all routed via EventEmitter2, see §8). `charge.refunded`/`charge.dispute.created` are logged for admin review only — no automated state transition.

**Note**: the online-order checkout/payment pipeline (`payment/` module) has its Stripe integration **fully commented out** — only the subscriptions/platform-billing side has live Stripe code. "Stripe" as an order `paymentType` today behaves identically to cash-on-delivery except for the label.

---

## 13. Notifications

No push notifications exist (Firebase is dead, see §5.6). All notifications are **transactional email** via `nodemailer`:

- `otp/otp.service.ts` — bare OTP mailer (hardcoded Gmail `from` address), used by `AuthService`.
- `otp/services/email.service.ts` — a separate, more complete templated mailer, currently **not wired as an injectable provider**.
- `subscriptions/subscription-notifications.service.ts` — buyer VIP-plan emails, sent via the `subscription-emails` BullMQ queue.
- `platform-plans/platform-plan-notifications.service.ts` — v2 seller-platform-billing emails, sent **synchronously**.
- `platform-subscriptions/platform-billing-notifications.service.ts` — v1 legacy seller-tier emails, sent **synchronously**, its own independent copy of the HTML email shell (not shared with the v2 version, by design, per code comments — keeps the two billing systems fully independent modules).

There is no unified `NotificationsModule` — each billing system deliberately owns its own email templates and sending path.

---

## 14. Shared Utilities

| File | Used by | Purpose |
|---|---|---|
| `common/idempotency.interceptor.ts` | subscriptions, platform-plans | Request-level dedup via `Idempotency-Key` header, Mongo-backed, 24h TTL |
| `common/number.util.ts` | finance, analytics | `round(n)` — 2-decimal money rounding, the platform-wide convention |
| `common/platform-earnings.util.ts` | admin-analytics, admin-finance | Combined commission + subscription-revenue platform-earnings formula (single source of truth) |
| `common/store-ownership.util.ts` | finance, analytics, (others via copy of pattern) | 3 distinct ownership-check helpers, each preserving a different pre-existing HTTP status behavior |
| `analytics/utils/analytics-date.util.ts` | analytics, admin-analytics | Date-range/bucket resolution, prior-period comparison |
| `analytics/utils/analytics-number.util.ts` | analytics, admin-analytics | Re-exports `common/number.util.round` |
| `analytics/utils/analytics-cache.util.ts` | analytics, admin-analytics | Redis-backed 10-min memoization wrapper |
| `analytics/utils/order-aggregation.util.ts` | analytics, admin-analytics | Core shared Mongo aggregation library (scope-parameterized so seller/platform-wide share identical logic) |
| `analytics/utils/csv.util.ts` | analytics, admin-analytics, admin-finance | Hand-rolled CSV builder (no CSV library dependency) |
| `analytics/utils/pdf-report.util.ts` | analytics, admin-analytics, admin-finance | `PdfReportBuilder` (built on `pdf-lib`) — text/table PDF reports, no chart images |

---

## 15. Cross-Cutting Design Decisions & Known Issues

**Deliberate patterns worth preserving**:
- `@Global()` modules (`ActivityLogModule`, `LoyaltyModule`, `SubscriptionsModule`, `QueueModule`, `DatabaseModule`) that avoid importing `AuthModule` directly, instead re-satisfying `JwtAuthGuard`/`RolesGuard`'s own dependency needs (`RedisModule`) — the established way to let auth-adjacent, widely-injected services avoid circular imports.
- Compensating-action pattern instead of Mongo transactions (e.g. `LoyaltyService.redeemReward` refunds points if a stock decrement fails after points were already deducted; `PaymentService.createOrder` rolls back prior stock decrements if one mid-loop fails).
- Two-pass computation to correctly gate business rules that depend on a value computed across the same batch (`CheckoutService.createCheckout`'s two-pass subscriber-discount gating against `minOrderValueUSD`).
- Route-ordering discipline with inline warning comments (Orders' `:orderId` last; POS's static routes before param routes) — Nest/Express is first-match, so this is load-bearing, not stylistic.

**Dead / unwired code** (do not assume these work without re-verifying first):
- `refund-request/` — every file 0 bytes, module unregistered.
- `firebase/` — module file empty, `FirebaseAdminService` fully commented out; `fcmToken` fields exist on schemas but nothing sends a push.
- `otp/otp.controller.ts` — fully commented out, 0 active routes; the dedicated `Otp` schema is unregistered.
- `auth/schemas/token-blacklist.schema.ts` — unregistered, unused.
- `payment/UserPaymentMethod.schema.ts` — fully wired repository, never read/written (no "saved cards" feature built yet).
- `otp/services/email.service.ts` — not a registered provider, currently not injectable.
- `subscriptions` Stripe `createCheckoutSession` — defined, never invoked.
- `upload/multer.config.ts`'s `createMulterOptions` — appears unused; the controller uses inline `memoryStorage()` instead.
- Several DTOs defined but never wired to a route: `auth/dto/refresh-token.dto.ts`, `auth/dto/social-login.dto.ts`, 4 DTOs in `auth/dto/verify-email.dto.ts`, `products/dto/update-product.dto.ts`, `products/dto/product-query.dto.ts`, `categories/dto/update-category.dto.ts`, `orders/dto/create-order.dto.ts`, `orders/dto/update-order-to-paid.dto.ts`, `address/dto/*` (schema field-name mismatch too — DTOs use `fullName`/`phone`, schema uses `recipientName`/`phoneNumber`), `cart/dto/validate-cart-response.dto.ts`.

**Known authorization gaps** (worth fixing opportunistically, not urgently unless asked):
- `faqs/` admin routes (`create`/`update`/`toggle`/`remove`/`admin/all`) require only `JwtAuthGuard`, no `RolesGuard('admin')` — any authenticated buyer/seller can currently mutate FAQs.
- `address/getAddressById` and `updateAddress` have no ownership check tying the address to the caller.
- `inventory/` — `@Roles('seller','admin')` but the ownership query still requires `sellerId === caller.userId`, so admin callers can't actually use it as intended.

**Duplication risks flagged for future consolidation** (do not silently merge without a migration plan — both are live):
- `platform-plans` (v2, DB-driven) vs `platform-subscriptions` (v1, hardcoded) — see §5.4.
- Two mailers in `otp/` (`OtpService` vs `EmailService`).
- Two product-creation code paths in `products/` (legacy `addProduct` vs. newer store-scoped flow).
- Two refund code paths (`OrdersService.returnRequest/Action` for online orders vs. `PosService.refundSale` for in-store) — expected given POS's deliberate isolation, not itself a bug.

---

## 16. Module Dependency Map

```
AuthModule ─┬─> OtpModule (mailer), RedisModule, ActivityLogService (no AuthModule import back)
            └─> (dead) google-auth-library groundwork

ActivityLogModule (@Global) ─> RedisModule only (avoids AuthModule circularity)
LoyaltyModule (@Global)     ─> EntitlementsService (platform-plans), ActivityLogService
SubscriptionsModule (@Global) ─> FinanceModule, QueueModule, EntitlementsService (platform-plans)

StoreModule      ─> ActivityLogService, SubscriptionBenefitsService, EntitlementsService, SellerPlatformSubscriptionsService
ProductsModule    ─> ActivityLogService, SubscriptionBenefitsService, EntitlementsService, Store's ProductType enum
CategoriesModule  <─ StoreModule, ProductsModule (category-tree validation)
InventoryModule   ─> (reads Product/ProductVariant/Store only)
BannersModule     ─> UploadModule (Cloudinary)

CartModule    <─ CheckoutModule (reads cartModel directly)
CheckoutModule ─> SubscriptionBenefitsService
OrdersModule   ─> UploadModule, FinanceModule, ActivityLogService, LoyaltyService, SubscriptionBenefitsService
PaymentModule  ─> (direct repository access only, bypasses Cart/Checkout/Orders services)
PosModule      ─> EntitlementsService, ActivityLogService (isolated from Cart/Checkout/Orders/Payment)

FinanceModule       <─ AdminFinanceModule, SubscriptionsModule, OrdersService
AdminFinanceModule  ─> FinanceModule, subscriptionInvoiceModel (read)
PlatformPlansModule ─> SubscriptionsModule (PaymentGatewayService, RefundInvoiceDto)
PlatformSubscriptionsModule ─> SubscriptionsModule (PaymentGatewayService)

RatingModule    ─> LoyaltyService (awardReviewPoints), reads orderModel directly
MessagingModule ─> SubscriptionBenefitsService, UploadModule
MarketingModule ─> ActivityLogService

AnalyticsModule (seller) ──┐
                            ├─> analytics/utils/* (shared aggregation core)
AdminAnalyticsModule ──────┘
AdminFinanceModule ─> common/platform-earnings.util.ts <─ AdminAnalyticsModule

SchedulerModule ─> SubscriptionsModule, PlatformSubscriptionsModule, FinanceModule, RedisModule, SeoModule
QueueModule (@Global) ─> consumed by subscriptions' 2 processors + seo's 3 processors
DatabaseModule (@Global) ─> consumed by literally every module via DatabaseService.repositories

SeoModule ─> RedisModule, FaqModule (Faq.seo admin controller), PlatformPlansModule (EntitlementsService + AiCreditsService)
  Product/Category/Store/Faq schemas ─> import SeoMeta/StoreSeo sub-schema from seo/schemas (reverse: content modules depend on seo/, not the other way around)
  SeoAuditService/SeoMonitoringService ─> EntitlementsService (advancedSeoToolsAllowed gating + scheduled-audit eligibility)
```

---

## 17. Future Roadmap

No roadmap existed prior to this document. Items below are inferred from in-code TODOs/comments and structural gaps found during this analysis — treat as candidate backlog, not committed plan, until confirmed with the user:

- Reconcile or formally deprecate one of `platform-plans` vs `platform-subscriptions` (§5.4/§15).
- Build the `refund-request/` module for real, or remove the dead scaffold entirely.
- Decide whether to build push notifications (Firebase) or remove the dead scaffold + unused `fcmToken` fields.
- Add COGS/cost tracking to `Product`/`ProductVariant` to unblock profit-margin analytics sorting.
- Add page-view/search-event tracking to unblock real funnel analytics beyond signup→first-order.
- Wire `IdempotencyInterceptor` onto Cart/Checkout/Orders/Payment (currently unprotected against retried mutating requests).
- Fix the 2 un-locked cron jobs (`runPlatformSubscriptionRenewals`, `finalizePlatformCancellations`).
- Close the `faqs/` and `address/` authorization gaps noted in §15.
- **SEO module** (§5.7) is now built. Remaining SEO follow-ups: provision real credentials (`GOOGLE_OAUTH_CLIENT_ID`/`SECRET`, `PAGESPEED_INSIGHTS_API_KEY`, `SEO_TOKEN_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`) before the integrations/AI features are functional in a live environment; build Merchant Center Reports API integration if product-listing click/impression data is needed; extend the embedded `SeoMeta` pattern to Collections/Blog once those modules exist.

---

## 18. Changelog

| Date | Change |
|---|---|
| 2026-07-14 | Initial creation. Full single-pass analysis of all 37 module directories, 35 NestJS modules, 34 controllers, 45 services, 59 schemas, 96 DTO files. Established as the sole backend reference document per standing instruction. |
| 2026-07-14 | Added the SEO module (`seo/`, §5.7) — Admin/Platform SEO + Seller/Store SEO, built across 12 phases per a dedicated architecture plan. +23 controllers, +14 services, +13 schemas (+3 embedded extensions on Product/Category/Store/Faq), +13 DTO files, +79 endpoints, +3 queues, +5 cron jobs, +4 `PlatformPlan.limits` flags. Added `@anthropic-ai/sdk` as a real dependency. Verified with `tsc --noEmit` after every phase and a final `nest build`, all clean. |
