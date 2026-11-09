# Smoke run 3 (2026-11-09), local throw-away services only
Rules followed: one heavy thing at a time, mongod with `--wiredTigerCacheSizeGB 0.5` (it ran out of memory once in run 2), results written after each item.

## Item 2: Redis: SKIPPED (no Redis)
Nothing answers on 127.0.0.1:6379 (connection refused). Only the in-memory fake Redis on :6399 exists (no EVAL, so BullMQ jobs cannot run). No binary was downloaded or run. Not verified for real: courier tracking sync, COD confirmation auto-cancel + restock, campaign send queue, scheduler crons, webhook retry via cron (the webhook delivery/retry logic itself is covered by the real-Mongo spec with a mocked HTTP client).

## Item 3: Stripe: SKIPPED (no keys)
No Stripe-named variable exists in the local environment. Not verified: paid order, refund, duplicate / out-of-order webhook delivery against real Stripe test mode.

## Item 1a: storefront at 375px (real Chrome, vite dev, local API)
Pages per theme: product, pre-order product, bundle, empty cart, cart with item, checkout, wholesale-only store seen by a visitor (prices hidden), /wholesale. First attempt rendered blank pages (cold vite compile); the script now waits for real content.
- Maison (theme-03-fashion): all 8 pages render, no horizontal overflow, no clipped buttons, no 5xx. Checkout and wholesale-only visitor view checked by eye: clean.
- Tech (theme-04-tech): all 8 pages render, no overflow, no 5xx. Pre-order product page shows "Pre-order" and NOT "Sold out" (regression fix (a) confirmed live in Tech; Maison check was run with stock 200, so only Tech confirmed live).
- Layout breaks found: none so far at 375 on the storefront.
