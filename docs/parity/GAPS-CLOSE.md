# Gaps close (2026-11-09)

## 1. Order detail action bar on phones: DONE
Under 640px the pinned bar shows at most two next-step buttons (priority: capture, fulfil, ready for pickup, delivered, completed, processing, mark as paid) plus a "More" menu with everything else (print slip/invoice, record payment, label, refund, cancel ...). The menu is the shared `ActionMenu` (role=menu, arrow keys, Escape closes and returns focus). No overflow scrolling any more. 640px and up: unchanged vertical stack.
Verified in Chrome at 375 (bar: "Fulfil items", "Mark Completed", "More"; no sideways scroll; keyboard Enter opens the menu with 7 items; Escape closes it; focus returns to the trigger) and at 768 (no fixed bar, desktop stack). Not covered: a screen-reader pass (roles/labels are standard, not heard).

## 4. Tech theme at 768px, one page at a time: DONE (with a correction)
Pre-order: renders, "Pre-order" shown and "Sold out" not shown, no overflow. Cart with an item: renders cleanly (table, summary, checkout button), no overflow. Checkout page: renders, no overflow (this run opened it with an empty cart).
Correction to SMOKE-RUN-3: the earlier "cart with item" checks clicked Add to cart before the product page had loaded, so for Tech at 375/768 that page was an EMPTY cart, not a cart with an item (Maison at 375 did have an item: its checkout showed Rs 200). The script now waits for the button. The 768 Tech blank screenshots earlier were that script timing, not a theme bug. Still open: Tech checkout with a filled cart at 375/768 and Maison cart-with-item at 768 re-confirmed only through the earlier empty/short-wait runs.
