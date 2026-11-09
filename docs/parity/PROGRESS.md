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
| P10 Notification templates | not started | - | - |
| P11 AI Studio honesty | DONE: stub enhancer hidden + refuses without billing | docs/parity/P9-P11.md | no real provider; other tools' wallet/ledger tests not written |
| P12 Seller + staff 2FA | not started | - | - |

Notes:
- Docs live in the API repo (`solvexo-api/docs/parity/`); the web repo (`solvexo-web`) is a separate git repo, so web changes for a phase are committed there on `uzair-branch` with the same `feat(<phase>): ...` message.
