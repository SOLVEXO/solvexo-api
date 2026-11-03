# solvexo-api

## Solvexo POS production-readiness effort (read first)

Ongoing phased effort (Phase 5A–5H). Earlier phases are documented in the repos.

### Repos and branches
- `solvexo-api/` — NestJS backend. Work only on branch `feature/jamibranch`.
- `pos/` — Flutter POS app (GetX, package `solvexo_pos`, remote `SOLVEXO/white-lable-pos`). Work only on branch `feature/jamibranch`.
- **Never commit to `main` in either repo.**
- "white-lable-pos" is a historical name. This is a single product (Solvexo POS), NOT white-label.

### Standing rules for every phase
- Read existing code before writing. Reuse existing patterns: BaseClient → Repository → Controller → View, GetX bindings, `IdempotencyInterceptor`, `writeAuditLog`, device tokens.
- The backend enforces every rule. Never fake a rule client-side.
- Don't change storefront/buyer-app behaviour. If a shared module changes, keep it backward compatible and document it (`pos/docs/buyer_app_changes.md`).
- Before finishing a phase run: `npm run build`, the POS-related backend suites (real Mongo/Redis), `flutter analyze`, `flutter test`, and `integration_test` on the iOS simulator (`--dart-define-from-file=config/env/dev.json`).
- End each phase with a summary doc in `pos/docs/`, push both branches, and STOP for owner approval.

### Where the docs are (`pos/docs/`)
- `phase5_production_readiness_audit.md` — audit and the 30 gaps (#1–#30)
- `phase5_decisions.md` — final decisions D1–D4 (money, web-only plan purchase, plan-only gating, shared-device model) and gap→phase map
- `phase5{A,B,C,C1_and_5D,D1_and_5E,E1_and_5F,F1_and_5G,G1_and_5H}_summary.md` — per-phase results, in order
- `store_submission_checklist.md`, `web_pos_plan_purchase_spec.md`, `web_dashboard_changes.md`, `buyer_app_changes.md`
- `deploy_runbook.md` (production order + rollback), `go_no_go.md` (blockers/verdict), `test_gap_matrix.md`
- Local full stack for real end-to-end runs: `solvexo-api/dev/README.md`; POS real-backend tests: `pos/tool/run_real_e2e.sh`; portal: `solvexo-account-web` (`npm run e2e:real`)
