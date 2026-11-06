# Parity run progress

Read MASTER.md first. Update this table after every phase.

| phase | status | commit | not-verified |
|---|---|---|---|
| P0 Theme parity | done (code) | web b7030f45 | no browser check of mini-cart notices |
| P1 Real-DB tests + money-path hardening | DONE for order placement, webhook idempotency, cancel restock (13 real-DB tests); remaining items listed in P1 doc | see git log | gift card, store credit, tax totals, finance ledger, return restock, POS bundle stock not covered |
| P2 B2B (+ addendum) | MOSTLY DONE: slices 1-8 (incl. company draft orders) (backend, terms/installments, seller hub, storefront, wholesale-only store, receivable credit notes, reminders, plan feature) | see git log | B2B-only sections, company addresses at checkout, WhatsApp reminders, i18n (en/ur), Liquid, wholesale price on cards, admin UI label for the plan feature, entitlements, createCheckout hook not run on real DB |
| P3 COD protection | IN PROGRESS: slices 1-2 (rules, score, guard, confirmation link + auto-cancel, backend) | see git log | storefront confirm page, seller UI, dashboard widget not built (do not enable for real stores yet) |
| P4 Messaging channels (WhatsApp/SMS) | not started | - | - |
| P5 Khata | not started | - | - |
| P6 Product feeds | not started | - | - |
| P7 Qisstpay | not started | - | - |
| P8 Webhooks + API tokens | not started | - | - |
| P9 Search & discovery | not started | - | - |
| P10 Notification templates | not started | - | - |
| P11 AI Studio honesty | not started | - | - |
| P12 Seller + staff 2FA | not started | - | - |

Notes:
- Docs live in the API repo (`solvexo-api/docs/parity/`); the web repo (`solvexo-web`) is a separate git repo, so web changes for a phase are committed there on `uzair-branch` with the same `feat(<phase>): ...` message.
