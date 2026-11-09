# Gaps close (2026-11-09)

## 1. Order detail action bar on phones: DONE
Under 640px the pinned bar shows at most two next-step buttons (priority: capture, fulfil, ready for pickup, delivered, completed, processing, mark as paid) plus a "More" menu with everything else (print slip/invoice, record payment, label, refund, cancel ...). The menu is the shared `ActionMenu` (role=menu, arrow keys, Escape closes and returns focus). No overflow scrolling any more. 640px and up: unchanged vertical stack.
Verified in Chrome at 375 (bar: "Fulfil items", "Mark Completed", "More"; no sideways scroll; keyboard Enter opens the menu with 7 items; Escape closes it; focus returns to the trigger) and at 768 (no fixed bar, desktop stack). Not covered: a screen-reader pass (roles/labels are standard, not heard).
