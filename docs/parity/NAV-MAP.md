# NAV-MAP (target, Shopify-style) and what is implemented in navConfig.ts

Source of truth in code: `solvexo-web/src/components/layouts/navConfig.ts` (`LAYOUT` map over `RAW_NAV`). Paths never change; old routes keep working.
Mobile menu (`StoreNavMenu`) and the command palette read the same `NAV`.

| Group (sidebar) | Items (implemented now) | Target items not built yet / in Settings hub |
|---|---|---|
| Overview (flat) | Dashboard, Analytics | Reports, Live view (inside Analytics tabs) |
| Orders | Orders, Draft Orders, Returns, Disputes, Payment Proofs | Abandoned checkouts, COD confirmation (filter tab on Orders, N3) |
| Products | Products, Collections, Categories, Inventory, Gift Cards, Subscriptions, Digital | Pre-orders (Inventory tab), Purchase orders (Inventory hub tab), Catalogs |
| Customers | Customers, Wholesale (= Companies), Khata, Reviews, Messages, Contact Messages, Loyalty | Segments; hub tabs Customers/Segments/Companies/Khata (follow-up, needs a hub page) |
| Marketing | Marketing (campaigns, automations), WhatsApp & SMS, Social creatives, SEO | |
| Discounts (top level) | Discounts | |
| Sales channels | Themes, Pages, Navigation, Blog, Files, Translate & adapt, Search & discovery, Experiments, Channels & feeds, Mobile App | Preferences (route exists, no item), POS (native app) |
| Apps (flat) | Connected apps | |
| Finance (flat) | Finance | |
| Settings (last) | Settings hub, Shipping, Checkout rules, COD protection, Webhooks & API, Help | Store details, Plan & billing, Users, Payments, Taxes, Locations, Markets, Notifications, Customer accounts, Languages, Domains live as tabs of the Settings hub |
| Account (avatar -> Account page) | Security (2FA) | not in the sidebar; reachable via `ACCOUNT_NAV` + Ctrl+K |

Rules: groups collapsible (closed by default, open when it holds the active page); permission-hidden for staff; plan-gated items use `requiredEntitlement` + upgrade page (`planGate.ts`); no duplicate ids; any new page is added to `LAYOUT` and to this table.
Not done in this step: Customers hub page with tabs, Security link inside the Account page UI (item exists in `ACCOUNT_NAV`).
