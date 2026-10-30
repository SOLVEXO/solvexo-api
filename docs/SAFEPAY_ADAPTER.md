# Safepay adapter for automatic membership renewal: what is missing

**Status: NOT IMPLEMENTED.** `SUBSCRIPTION_PROVIDERS.safepay` (`src/memberships/subscription-provider.ts`) and
`SafepayMembershipProvider` (`src/memberships/safepay-membership.provider.ts`) only detect configuration and report
"not implemented". No Safepay recurring call is made anywhere. Pakistani stores use **manual billing** (renewal invoices,
the buyer pays the seller directly and uploads a receipt, the seller approves). The seller UI says:
"Auto billing is not available in your country yet; use Manual billing."

The existing one-time Safepay checkout (`src/integrations/providers/safepay.provider.ts`) is a different thing: it takes a single
payment through Safepay's hosted checkout. It was never run against a sandbox either (see the header of that file).

## What must exist before this can be built

1. **Sandbox account** at https://sandbox.api.getsafepay.com (separate from production) and its credentials:
   - `SAFEPAY_API_KEY` (public key), `SAFEPAY_SECRET_KEY` (server key), `SAFEPAY_WEBHOOK_SECRET` (HMAC secret for webhooks),
     `SAFEPAY_ENV=sandbox`.
2. **Written confirmation from Safepay that recurring / saved-card (tokenised) charging is available to Pakistani merchants**,
   plus its documentation. Without it there is nothing to call: Safepay's public SDK documents one-time checkout sessions, trackers
   and webhooks, not subscriptions. Unknown and to be answered by Safepay:
   - How a card is stored for later charges (token / "tbt" meaning, customer vault, 3-D Secure re-authentication rules).
   - The endpoint to charge a stored card for the next cycle and its idempotency mechanism.
   - How a failed charge is reported, and whether Safepay retries on its own.
   - Whether the money settles to the seller's own merchant account (required by the platform money rule: Solvexo never holds buyer funds).
3. **Webhook events** to subscribe to, with exact names and payload shape: payment succeeded, payment failed, card/token updated or
   expired, charge refunded. The signature scheme for the existing one-time flow is HMAC-SHA256 (see `safepay.provider.ts`);
   confirm it is the same for recurring events.
4. A **per-seller key model**: each seller connects their OWN Safepay merchant keys (like the existing Safepay integration), so the
   charge goes straight to the seller. Platform-wide keys would make Solvexo the merchant of record, which the rules forbid.

## What the adapter will need to do once the above exists

Same contract as `StripeMembershipProvider`:
- availability gate (store country PK + seller keys connected + sandbox/live mode),
- create a hosted setup/checkout that stores the card and takes the first payment,
- webhook receiver: raw-body signature check, idempotent through `WebhookEvent` (`providerEventId`), conditional updates only,
- renewal charge / retry ladder 1 / 3 / 5 / 7 days, then grace days, then revoke (the same BullMQ `membership-billing` queue),
- cancel at period end, pause / resume, plan change with proration, payment-method update link,
- specs on a fake Safepay client, then ONE real sandbox run before anything is claimed.

Until a sandbox run has happened, nothing in this repository may claim that Safepay auto-renewal works.
