# NAV inventory (phase N step 1) - source: solvexo-web/src/components/layouts/StoreLayout.tsx, `NAV` (line ~101)

Current groups -> items (id: path). Mobile bottom bar (fixed): dashboard, orders, products, messages, More(settings). Mobile menu reuses `NAV`.

- Overview: dashboard, analytics
- Catalog (collapsible): products, inventory, categories, collections
- Orders (collapsible; became a dumping ground): orders, digital, wholesale, subscriptions, checkout-rules, experiments, creatives, cod-protection, messaging (WhatsApp & SMS), khata, sales-channels, developers (Webhooks & API), connected-apps (app-platform), search-settings, security (2FA), draft-orders, payment-proofs, returns, disputes, shipping
- Customers: customers (customer/list), reviews, messages, online-store-contact
- Online Store: themes, pages, menus (Navigation), blog, files, translations
- Marketing: marketing, discounts
- Growth Tools: gift-cards, loyalty (flag), seo, ...
- Finance: finance
- Sales Channels: mobile-app
- Settings: settings (hub), help

Hidden/URL-only pages (ROUTE_RULES): products/add|edit, draft-orders/new, purchase-orders, reorder-suggestions, inventory/count, plan-billing, staff, online-store/contact-messages|preferences|translations, settings/markets.

Findings vs target map (NAV-MAP.md, to write next): "Orders" group holds 20 unrelated items; Discounts sits under Marketing (target: top-level); Gift cards/Subscriptions/Catalogs belong under Products; Khata/Companies(wholesale) under Customers; Experiments/Search & discovery under Sales channels > Online Store; COD protection/Developers/Shipping/Checkout rules belong in Settings; Security 2FA belongs in the avatar menu. Lines 224-272 (Growth tail, Finance, Settings hub tabs) not yet inventoried.
