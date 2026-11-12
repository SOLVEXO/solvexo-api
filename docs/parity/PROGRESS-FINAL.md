# FINAL run progress

Read FINAL.md first. MASTER2.md is superseded by FINAL.md. Q0-Q9 were already done under MASTER2 (see PROGRESS2.md); they are carried over here and skipped. Docs live in the API repo; web changes are committed in `solvexo-web`.

| phase | status | commit | not-verified |
|---|---|---|---|
| N Navigation / information architecture | DONE; orders view filter now tested on real Mongo 7 (6 tests, ORDERVIEW_IT_MONGO) (sidebar checked in real Chrome with mocked API at 1366px + 375px: new groups render, mobile bottom bar + More menu ok; order view tabs (view=unpaid sent to API), no row menu, bulk bar (Mark as paid, Export CSV) and Customers/Companies/Khata tab strip verified in Chrome with mocked API): N1+N2 done (navConfig LAYOUT map, NAV-MAP.md, tsc clean; Customers hub tabs + Security link in Account page open); N3 done (view tabs + server filter, row menu removed, Edit order in header; bulk Mark as paid + Export CSV built; tag/archive not built (no backend concept); Customers hub tab strip + Security link on Account built); N4 done (palette already built from NAV; account pages added); N5 test written (navConfig.test.ts, 5/6 passed once, route regex fixed after; now 6/6 pass; the earlier vitest failure was a drive-letter case problem (run from D:/ not d:/)) + browser check at 375px/desktop NOT done; was N4 Ctrl+K, N5 tests open | web N1 commit | browser 375px + desktop | browser 375px + desktop |
| Q0 Housekeeping | done under MASTER2 (scheduler-job tests open) | see PROGRESS2.md | browser, Redis pub/sub, scheduler locks |
| Q1 B2B | done under MASTER2 | see PROGRESS2.md | browser, real SMTP |
| Q2 Small gaps | done under MASTER2 | see PROGRESS2.md | wallets on real Stripe |
| Q3 3PL | done under MASTER2 | see PROGRESS2.md | real 3PL, Redis worker |
| Q4 Product subscriptions | done under MASTER2 (manual-pay renewals only) | see PROGRESS2.md | card-on-file recurring, real cron |
| Q5 Checkout rules | done under MASTER2 | see PROGRESS2.md | real checkout, cart preview UI |
| Q6 A/B experiments | done under MASTER2 | see PROGRESS2.md | real traffic, first-paint flicker |
| Q7 App platform | done under MASTER2 | see PROGRESS2.md | real app, iframe, token expiry |
| Q8 Social creatives | done under MASTER2 | see PROGRESS2.md | real-browser canvas, CORS export |
| Q9 Final audit | done under MASTER2; route-auth scan re-run after N: 2/2 pass (mini-jest) | see PROGRESS2.md | Atlas explain(), live services |
