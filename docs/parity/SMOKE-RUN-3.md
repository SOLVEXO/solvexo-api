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

## Item 1b: seller pages at 375px
Orders, Order detail, Inventory, Khata, Wholesale, COD protection, WhatsApp & SMS, Security: all render, no horizontal page overflow, no 5xx.
Real layout problems found:
1. Seller page title truncated to "Invent..." on phones (28px title next to store switcher + bell + avatar). FIXED: 22px under 640px (web `89975e31`); re-checked, "Inventory" now shows in full. Long titles such as "Order OR..." still truncate (order number), acceptable.
2. Bundle lines on the seller order showed "Item x 1 / Item x 2" (component names were never stored on the order snapshot). FIXED in checkout (readable "Product (options)" name, frozen on the order) with `bundle-name.spec` (api `0aea8f2`). Existing orders keep the old label.
3. Order detail on a phone: the pinned action bar (Print packing slip / Print invoice / Mark ...) scrolls sideways and the third button is cut off at 375 with no hint that it scrolls. NOT changed (deliberate design of the earlier mobile pass; needs a design decision, e.g. wrap to two rows).
Automatic "clipped buttons" counts on Inventory (7) and Wholesale (1) are horizontally scrollable tab/toolbar strips, not broken layouts.

## Item 1c: 768px
- Maison: all 8 storefront pages OK, no overflow (one transient "Failed to fetch dynamically imported module" from the vite dev server re-optimizing, not a layout issue); pre-order page shows "Pre-order", not "Sold out".
- Tech: product, bundle, empty cart, hidden-price visitor, wholesale OK, no overflow. NOT VERIFIED at 768: pre-order, cart with item, checkout (two screenshot timeouts of 30 s and one page that did not render while the machine was under load). Re-run on a quieter machine.
- Seller pages at 768: all 8 render, no overflow.

## Not verified in this run
Real Redis/queues (skipped), Stripe (skipped), Tech at 768 for three pages, themes beyond Maison and Tech (the registry only has these two), real devices/Safari/Firefox, B2B visitor view of the Tech theme beyond "page renders".
