# P0 Theme parity

Themes in the registry: `theme-03-fashion` (Maison), `theme-04-tech`.
Shared pieces live in `solvexo-web/src/features/storefront-themes/core/merchandising/` (commit `ea9d929c`) and are documented in `THEME_CONTRACT.md` ("Selling features every theme MUST show").

Audit result (2026-11-06):
| piece | Maison | Tech |
|---|---|---|
| product pre-order note + button | yes | yes |
| bundle "includes" list | yes | yes |
| cart page line pre-order / bundle badge | yes | yes |
| mini cart line pre-order | MISSING -> added | yes |
| mini cart bundle badge | MISSING -> added | MISSING -> added |
| cart upsell | yes | yes |
| checkout line note | yes | yes |

Not verified: no browser check of the two mini carts.
