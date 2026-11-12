# P5 Khata (customer ledger): done in code, seller records only

Run: `MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit khata` (needs a replica set: postings use transactions).
Solvexo moves and holds no money here; this is the seller's own book.

## Built
- `src/khata/`: `KhataAccount` (per store + customer, balance, optional seller credit limit) and append-only `KhataEntry` (sale / payment / adjustment / reversal, running `balanceAfter`, gapless `seq`). Mistakes are fixed by a **reversal** entry (once per entry, a reversal cannot be reversed), never by edit or delete. Adjustments need a note.
- **Concurrency:** one atomic update of the account (`$inc` with the limit check inside the filter) plus the entry insert in one transaction. Tested: 20 parallel postings keep balance = sum of entries; 3 parallel sales against a limit let exactly the fitting ones through; automatic entries are idempotent per `sourceKey` even in parallel.
- Routes `api/khata/:storeId/...` (perm `khata.view` / `khata.manage`, in the staff presets Store Manager / Support Staff via preset version 4; store pinned by the guard): accounts list/create, entries list/post, reverse, limit, aging per customer and report, statement JSON + CSV (formula-guarded), POS sale on account / release, SMS reminder. Every change is written to the activity log (`category: khata`).
- **Aging:** payments are applied to the oldest debits first, the remainder is bucketed by days past due (not due, 1-30, 31-60, 61-90, 90+).
- **B2B net-terms:** the receivable of every terms order is mirrored into the company's khata account (`syncB2BOrder`, called after placement, payment, void and credit note): sale at the original total, credit notes as adjustments, payments, a reversal for a voided payment. Computed from the order, so it is idempotent. The B2B receivable stays the source of truth and the B2B credit-limit check at checkout is unchanged; mirrored entries are recorded even above a khata limit (the order was already agreed).
- **POS udhaar:** `POST accounts/:id/pos-sales/:saleId` puts a completed POS sale taken with tender "other" (nothing collected) on the account (limit applies, once per sale); `POST pos-sales/:saleId/release` takes a voided / fully refunded sale off it.
- **Reminders:** `POST accounts/:id/remind` sends one SMS over the P4 gateway, only if the platform messaging flag is on, the customer opted in to SMS from this store, the store's SMS provider is on, and no reminder went out in the last 24 h (a failed send does not use the day).
- Web: seller page `/store/:id/khata` (Customers with totals, customer dialog with entries, post sale/payment/adjustment, reverse, limit, aging chips, CSV, print statement, SMS reminder; Aging report tab). Staff permission labels added.
- Tests: 26 (pure rules + real Mongo), 4 web vitest.

## Not done / not verified
- The POS app has no native "udhaar" tender: the seller takes the sale as "other" and then puts it on the account (a refund/void must be released by hand).
- Mirror skips orders whose currency differs from the account currency (one account = one currency).
- WhatsApp reminders (need an approved template), automatic scheduled reminders, a printable PDF (browser print only), customer-facing view of their own balance, en/ur strings, plan entitlement, import of existing balances.
- Nest DI boot with the new module not run (jest + tsc only). Nothing run in a browser or against Atlas.
