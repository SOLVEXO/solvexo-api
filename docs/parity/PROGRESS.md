# Parity run progress

Read MASTER.md first. Update this table after every phase.

| phase | status | commit | not-verified |
|---|---|---|---|
| P0 Theme parity | done (code) | web b7030f45 | no browser check of mini-cart notices |
| P1 Real-DB tests + money-path hardening | DONE for order placement, webhook idempotency, cancel restock (13 real-DB tests); remaining items listed in P1 doc | see git log | gift card, store credit, tax totals, finance ledger, return restock, POS bundle stock not covered |
| P2 B2B (+ addendum) | MOSTLY DONE: slices 1-8 (incl. company draft orders) (backend, terms/installments, seller hub, storefront, wholesale-only store, receivable credit notes, reminders, plan feature) | see git log | B2B-only sections, company addresses at checkout, WhatsApp reminders, i18n (en/ur), Liquid, wholesale price on cards, admin UI label for the plan feature, entitlements, createCheckout hook not run on real DB |
| P3 COD protection | DONE in code (rules, score, guard, confirmation link, auto-cancel, UI, widget) | api 322ade8, web 8fc04ce4 | no browser/SMTP/WhatsApp run; en/ur strings; WhatsApp template needs Meta approval |
| P4 Messaging channels (WhatsApp/SMS) | DONE in code (backend + seller UI + buyer preferences page), flag-gated OFF | see git log | no browser run, live Meta / SMS gateways never run, no checkout opt-in, no en/ur, no entitlement |
| P5 Khata (customer ledger) | DONE in code (ledger, aging, statements, B2B mirror, POS udhaar, SMS reminders, seller page) | see git log, docs/parity/P5-khata.md | no browser/DI-boot run, no WhatsApp reminders, no native POS tender, no en/ur |
| P6 Product feeds | DONE in code (Google XML + Meta CSV, health, Sales channels page) | docs/parity/P6-P8.md | feed never uploaded to Google/Meta; Meta columns from memory |
| P7 Qisstpay | ADAPTER ONLY: disabled, unverified, not connectable | docs/parity/P7-qisstpay.md | needs official guide + sandbox (OPEN-QUESTIONS) |
| P8 Webhooks + API tokens | DONE in code for order events + read-only API; product/inventory/customer events and write endpoints NOT wired | docs/parity/P6-P8.md | no real receiver, no DI boot, DB-backed retry (not BullMQ) |
| P9 Search & discovery | DONE in code (synonyms, pins, filter settings, no-results report, seller page) | docs/parity/P9-P11.md | themes do not read filter settings yet; no browser run |
| P10 Notification templates | ALREADY BUILT earlier (editor, preview, reset, allow-listed tags); re-verified: 60 notification tests pass | docs/parity/P10-P12.md | not re-checked in a browser or on real SMTP |
| P11 AI Studio honesty | DONE: stub enhancer hidden + refuses without billing | docs/parity/P9-P11.md | no real provider; other tools' wallet/ledger tests not written |
| P12 Seller + staff 2FA | DONE in code core (TOTP + recovery codes, login challenge, lockout, replay guard, step-up on staff removal and gateway connect, owner reset API, staff policy flag, login step + Security page) | api 0d78288, web 6c67bffc | step-up not on email/password change; no reset button; policy is a soft flag; no social/POS-PIN coverage; no browser run |

Notes:
- Docs live in the API repo (`solvexo-api/docs/parity/`); the web repo (`solvexo-web`) is a separate git repo, so web changes for a phase are committed there on `uzair-branch` with the same `feat(<phase>): ...` message.

## Run summary (2026-11-09)
- Code-complete on `uzair-branch` (api + web), nothing pushed, nothing deployed: P0-P6, P9-P12. P7 is an adapter only. P8 covers order events + read-only API only.
- Everything was verified with `tsc`, jest on a LOCAL real Mongo 7 replica set, and web tsc/eslint/vitest. Nothing was run in a browser, against Atlas, Redis, real SMTP, Stripe, Meta, SMS gateways, Google/Meta feeds or an authenticator app. No Nest DI boot was run for the modules added from P5 on.
- Deferred by MASTER ("NOT IN THIS RUN"): product subscriptions, Shopify Functions, 3PL, A/B testing, third-party app platform, FBR POS, Safepay recurring, multi-wholesaler network, lending/credit.

## What the owner must supply
1. Qisstpay: official merchant integration guide + sandbox credentials (P7).
2. WhatsApp: a Meta business account / WABA per store, approved marketing templates; confirm tier limits (P4).
3. SMS: the documentation or sandbox of the chosen Pakistani SMS gateway(s) (P4).
4. Image enhancement: a vendor + API key (P11); `ANTHROPIC_API_KEY` (AI Studio text, auth photo vetting).
5. Set `MESSAGING_CAMPAIGNS_ENABLED=true` only after the sandbox tests above; set `ADMIN_2FA_ENCRYPTION_KEY` (falls back to JWT_SECRET) and keep `INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY` for webhook secrets.
6. A staging environment with real Mongo/Redis/SMTP to run: Nest boot, the new unique indexes, the order webhook flow, a Google Merchant / Meta catalog feed test upload.
7. Decisions: whether staff 2FA must be hard-enforced (setup-only session), and whether the remaining sensitive actions (email/password change) need step-up.

## ONE next task
Boot the API against a throw-away staging database and walk one order end to end (checkout -> webhook delivery -> khata mirror -> feed item), fixing whatever the real run breaks.
