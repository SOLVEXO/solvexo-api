# P1 Real-DB tests + money-path hardening (IN PROGRESS)

Run (needs a standalone mongod; throw-away DB, dropped afterwards):
  MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest payment.money.integration
Without MONGO_TEST_URI the suite is skipped. `mongodb-memory-server` is declared in package.json but not installed on this machine; a local mongod 7 binary was used instead.

## Covered (src/payment/payment.money.integration.spec.ts, real schemas, real Mongo)
- 5 buyers racing for the last unit -> 1 order, committedStock 1
- qty-2 orders racing on stock 5 -> never over-reserves
- same checkout placed twice at once -> one order
- pre-order limit under concurrency
- multi-line checkout failing on line 2 releases line 1
- order insert failing after reservation releases the reservation

## Bugs found and fixed
1. Parallel placement of one checkout (double click, webhook retry vs poller) created TWO orders and reserved stock twice: `createOrder` only de-duplicated with a read. Now an atomic claim on `Checkout.orderPlacementClaimedAt` (stale after 2 min); the loser waits for the winner's orders.
2. A failed `orderModel.create` after stock reservation never released `committedStock` / `preorder.sold` (stock stuck committed forever). Now released in a catch. (Found by code reading; the new regression test passes with the fix, it was not run against the unfixed code.)

## Still to do in P1
coupon usageLimit race, gift card / store credit redemption, totals/tax, payment webhook idempotency (duplicate/out-of-order), finance/refund paths, POS + draft-order bundle stock, cancel/return restock.
