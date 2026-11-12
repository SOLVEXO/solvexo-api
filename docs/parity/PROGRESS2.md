# Master 2 progress

Read MASTER2.md first. Update after every phase. Docs live in the API repo; web changes are committed in `solvexo-web` with the same message.

| phase | status | commit | not-verified |
|---|---|---|---|
| Q0 Housekeeping | done (a-d; scheduler-job tests open) | web 41c63698, api 94c87b7 + next | browser, Redis pub/sub, scheduler locks |
| Q1 B2B completion | done (gaps: decision notice, strings; rest already built) | next commit | browser, real SMTP |
| Q2 Shopify small gaps | done (local-delivery order tag + filter; rest verified) | next commit | browser, wallets on real Stripe |
| Q3 3PL / fulfillment services | done (registry, queue, signed callbacks, stock sync, UI) | next commit | real 3PL, Redis worker, browser |
| Q4 Product subscriptions | done (manual-pay renewals only; plans, contracts, engine, dunning, UI) | next commit | card-on-file recurring (not built), browser, real cron |
| Q5 Checkout rules | done (4 rule types, enforcement, test tool, branding in 3 themes) | next commit | real checkout run, browser, cart preview UI |
| Q6 A/B experiments | not started | - | - |
| Q7 App platform | not started | - | - |
| Q8 Social creatives | not started | - | - |
| Q9 Final audit | not started | - | - |
