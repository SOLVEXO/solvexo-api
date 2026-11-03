# Changelog — solvexo-api

## 1.0.0 — release candidate (branch `feature/jamibranch`, POS work 5A–5H)
Shared-module changes that touch buyer/storefront behaviour are listed in `pos/docs/buyer_app_changes.md` (only one is breaking: add-to-cart refuses sold-out physical variants).

### Added
- **POS entitlement:** `PosEntitlementGuard` (`POS_ENTITLEMENT_ENFORCED`, default off), plan-only gating (platform trial guard removed from POS routes), optional plan limits, admin grant/extend/revoke, Stripe webhooks for checkout/async/refund/dispute/`charge.dispute.closed`; public `GET /api/pos-checkout/session-status`.
- **POS integrity:** `IdempotencyInterceptor` on all money routes, atomic sale pipeline, unique open-session index, server totals + quote, currency/exponent snapshot, split tender, per-tender refunds, offline sync rules (72 h window, `settingsVersion`, price history, flags, review/discard).
- **Devices & RBAC:** device tokens (register/list/revoke), `PosAuthGuard`, manager-PIN gate, employee-token revocation, PIN lockout (5/15 min), per-device rate limit, `POS_LEGACY_AUTH_ALLOWED`.
- **Auth:** Sign in with Apple (multiple audiences, keyed by `sub`, relay/placeholder emails, encrypted refresh-token storage, **revocation at account purge with retry**); `POST /api/auth/refresh`; **portal cookie sessions** (HttpOnly rotating refresh family, reuse detection, CSRF double-submit + Origin check; opt-in via `X-Auth-Mode: cookie`; mobile flow unchanged).
- **Account deletion:** owner re-auth by password or Google/Apple; public OTP-verified request; 30-day grace; scheduled purge that de-identifies but keeps sales/tax records.
- **Config:** `PORTAL_ORIGINS`, `AUTH_COOKIE_DOMAIN`, `CSRF_SECRET`, `APPLE_*`, `APPLE_TOKEN_ENC_KEY` (see `.env.example`).
- **Rollout tooling:** `pos-preflight-open-sessions.ts`, `pos-plan-backfill.ts`; dev-only local stack (`dev/`, `docker-compose.dev.yml`, seed, smoke).

### Fixed
- `reset-pin` now accepts exactly the 4-digit PINs PIN-login accepts; force-close is status-guarded (no overwrite of a shift just closed); online stock ≤ 0 is never purchasable unless unlimited/backorder; negative stock is never shown to buyers; customer search store-scoped for POS.

### Changed
- Package version `0.0.1` → `1.0.0`.
