# P7 Qisstpay (BNPL): adapter only, disabled and UNVERIFIED
- `providers/qisstpay.provider.ts` implements the `PaymentProvider` contract and is registered in `PaymentProviderRegistry`, but every call that would move money throws "not available yet"; `testConnection` answers not ok.
- Catalog entry `qisstpay` is `unverified: true`, `generic: false`: it is not offered or connectable, and excluded from country lists.
- Nothing about Qisstpay's real API is invented. Field names/endpoints/signature are in OPEN-QUESTIONS.md (needs the official guide + sandbox).
- `installmentMessage()` is only wording (no fees stated); the storefront does not show it because no verified, enabled integration can exist yet.
- Tests: `qisstpay.provider.spec.ts` (4), registry/catalog/integration specs updated (37 pass).
