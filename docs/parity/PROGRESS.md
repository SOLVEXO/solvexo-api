# Parity run progress

Read MASTER.md first. Update this table after every phase.

| phase | status | commit | not-verified |
|---|---|---|---|
| P0 Theme parity | done (code) | web b7030f45 | no browser check of mini-cart notices |
| P1 Real-DB tests + money-path hardening | DONE for order placement, webhook idempotency, cancel restock (13 real-DB tests); remaining items listed in P1 doc | see git log | gift card, store credit, tax totals, finance ledger, return restock, POS bundle stock not covered |
| P2 B2B (+ addendum) | IN PROGRESS: slices 1-3 (backend admin, rules, checkout enforcement, payment terms/installments/credit limit) | see git log | storefront UI, reminders, web admin, entitlements, createCheckout hook not run on real DB |
| P3 COD protection | not started | - | - |
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
