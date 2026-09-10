/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Block, BlockSchema } from '../../common/schemas/block.schema';

export type StoreThemeDocument = HydratedDocument<StoreTheme>;

@Schema({ _id: false })
export class PreviewToken {
  @Prop({ required: true }) token: string;
  @Prop({ type: Date, required: true }) expiresAt: Date;
}
export const PreviewTokenSchema = SchemaFactory.createForClass(PreviewToken);

// A named, reusable saved palette — "Apply"-ing one copies its 3 values onto
// the theme's own live bgColor/textColor/primaryColor fields (draft), the
// same fields the Theme Settings color pickers already edit directly. This
// is deliberately a "saved presets" layer on top of the existing flat-color
// system, not per-section scheme assignment (Shopify's `color_scheme_group`,
// where each SECTION can independently pick a scheme) — that would require
// a `colorScheme` setting on every section/block across both themes' render
// files, a much larger follow-up. A seller can still save/reuse/switch
// between named palettes for the whole storefront with this; there's just
// one active palette at a time, not one per section.
@Schema({ _id: false })
export class ColorScheme {
  @Prop({ required: true }) id: string;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) bgColor: string;
  @Prop({ required: true }) textColor: string;
  @Prop({ required: true }) primaryColor: string;
}
export const ColorSchemeSchema = SchemaFactory.createForClass(ColorScheme);

@Schema({ _id: false })
export class StorefrontColors {
  @Prop({ type: String, default: '#D97757' }) primaryColor: string;
  @Prop({ type: String, default: '#FAF9F5' }) bgColor: string;
  @Prop({ type: String, default: '#2C2A28' }) textColor: string;
  @Prop({ type: String, default: '#B95A3A' }) accentColor: string;
  @Prop({ type: String, default: 'Poppins' }) font: string;
  // How `ThemedButton` renders a primary CTA — filled / bordered / tinted.
  @Prop({ type: String, enum: ['solid', 'outline', 'soft'], default: 'solid' })
  buttonStyle: 'solid' | 'outline' | 'soft';

  // ── Real design-system dimensions (not just color) — see `themes.ts` on
  // the frontend for the curated bundles that set all of these together.
  // Every default below reproduces today's actual rendered look exactly, so
  // a pre-existing store is pixel-identical until a seller changes anything.
  @Prop({ type: String, enum: ['compact', 'comfortable', 'spacious'], default: 'comfortable' })
  typeScale: 'compact' | 'comfortable' | 'spacious';

  @Prop({ type: String, enum: ['narrow', 'standard', 'wide'], default: 'standard' })
  containerWidth: 'narrow' | 'standard' | 'wide';

  @Prop({ type: String, enum: ['compact', 'comfortable', 'spacious'], default: 'comfortable' })
  sectionSpacing: 'compact' | 'comfortable' | 'spacious';

  @Prop({ type: String, enum: ['sm', 'md', 'lg'], default: 'md' })
  buttonSize: 'sm' | 'md' | 'lg';

  // ── Buttons scope — independent from product/testimonial cards and from
  // standalone images. Only `ThemedButton` reads these. ──
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large', 'full'], default: 'medium' })
  buttonRadius: 'none' | 'small' | 'medium' | 'large' | 'full';
  @Prop({ type: String, enum: ['auto', 'full'], default: 'auto' })
  buttonWidth: 'auto' | 'full';

  // ── Images scope — corner radius for a standalone content image
  // (`ImageWithTextSection`). Independent of buttons/cards. Default 'medium'
  // reproduces that section's previously-hardcoded `rounded-xl` look exactly.
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large', 'full'], default: 'medium' })
  imageRadius: 'none' | 'small' | 'medium' | 'large' | 'full';

  @Prop({ type: String, enum: ['overlay', 'split'], default: 'overlay' })
  heroStyle: 'overlay' | 'split';

  @Prop({ type: String, enum: ['left', 'center'], default: 'left' })
  heroAlignment: 'left' | 'center';

  // ── Product Cards scope — independent from testimonial cards. Default
  // values reproduce the old shared `cardStyle`/`borderRadius` defaults
  // exactly (both were 'outlined'/'medium'), so a pre-existing store's
  // product grid renders pixel-identical.
  @Prop({ type: String, enum: ['flat', 'outlined', 'elevated'], default: 'outlined' })
  productCardStyle: 'flat' | 'outlined' | 'elevated';
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large', 'full'], default: 'medium' })
  productCardRadius: 'none' | 'small' | 'medium' | 'large' | 'full';

  @Prop({ type: String, enum: ['square', 'portrait'], default: 'square' })
  productImageRatio: 'square' | 'portrait';

  @Prop({ type: String, enum: ['none', 'zoom'], default: 'none' })
  productImageHover: 'none' | 'zoom';

  @Prop({ type: String, enum: ['cozy', 'relaxed'], default: 'cozy' })
  productGridDensity: 'cozy' | 'relaxed';

  @Prop({ type: String, enum: ['cards', 'minimal'], default: 'cards' })
  testimonialStyle: 'cards' | 'minimal';
  // ── Testimonials scope — independent from product cards, same
  // backward-compatible defaults as the old shared token. ──
  @Prop({ type: String, enum: ['flat', 'outlined', 'elevated'], default: 'outlined' })
  testimonialCardStyle: 'flat' | 'outlined' | 'elevated';
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large', 'full'], default: 'medium' })
  testimonialCardRadius: 'none' | 'small' | 'medium' | 'large' | 'full';

  @Prop({ type: String, enum: ['accordion', 'list'], default: 'accordion' })
  faqStyle: 'accordion' | 'list';

  @Prop({ type: [ColorSchemeSchema], default: [] })
  colorSchemes: ColorScheme[];
}
export const StorefrontColorsSchema = SchemaFactory.createForClass(StorefrontColors);

// Header/footer are bespoke fields (not wrapped in the generic `Section` type
// used for page content) — they're singletons, never reorderable/deletable
// relative to siblings, so `Section`'s "one of many" semantics would buy
// nothing here. They still reuse the shared `Block` shape for their own
// content units (nav_link / footer_column / social_link / copyright_text —
// see section-settings.validator.ts for the allowed shape of each).
@Schema({ _id: false })
export class StorefrontHeader {
  @Prop({ type: String, enum: ['store', 'custom'], default: 'store' }) logoSource: 'store' | 'custom';
  @Prop({ type: String, default: null }) customLogoUrl: string | null;
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[]; // nav_link blocks only
  // Where the nav-link group sits relative to the logo — the icons (cart/
  // account) always stay pinned to the far right regardless of this.
  @Prop({ type: String, enum: ['left', 'center', 'right'], default: 'left' })
  navAlignment: 'left' | 'center' | 'right';
  // Overall header composition — 'standard' is today's logo-left/inline-nav
  // layout; 'centered' stacks a centered logo with nav below it.
  @Prop({ type: String, enum: ['standard', 'centered'], default: 'standard' })
  headerStyle: 'standard' | 'centered';
  // When set, the storefront renders THIS menu's items instead of `blocks`
  // above — resolved into the identical `Block` shape at read time
  // (`StoreThemeService`'s `resolveHeaderMenu`), so neither theme's Navbar
  // component needed any changes to support it. `blocks` is left untouched
  // as the fallback content, not cleared — detaching the menu (`null`)
  // instantly reverts to whatever links were there before, with nothing
  // lost. Real standalone `Menu` documents live in their own collection —
  // see `menus/schemas/menu.schema.ts`'s own class comment for the full
  // rationale and the (disclosed) footer-attachment boundary.
  @Prop({ type: String, default: null })
  menuId: string | null;
}
export const StorefrontHeaderSchema = SchemaFactory.createForClass(StorefrontHeader);

@Schema({ _id: false })
export class StorefrontFooter {
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[]; // footer_column / social_link / copyright_text blocks
  // 'columns' is today's multi-column layout; 'minimal' is a single centered
  // row (store name + copyright + socials, no columns).
  @Prop({ type: String, enum: ['columns', 'minimal'], default: 'columns' })
  footerStyle: 'columns' | 'minimal';
  // The disclosed footer-attachment follow-up `StorefrontHeader.menuId`'s own
  // doc comment flagged: footer `blocks` mix `footer_column`/`social_link`/
  // `copyright_text`, not just links, so a menu can't wholesale replace
  // `blocks` the way it does for Header. Instead, when set, the resolved
  // menu becomes ONE synthetic `footer_column` block (heading = the menu's
  // own name, links = its items) that REPLACES only the footer's own
  // `footer_column` block(s) — any `social_link`/`copyright_text` blocks are
  // left untouched and keep rendering alongside it. See
  // `StoreThemeService.resolveFooterMenu`. `blocks`' own footer_column
  // content is left untouched (not cleared) so detaching (`null`) instantly
  // reverts to it, same "nothing lost" guarantee `StorefrontHeader.menuId` gives.
  @Prop({ type: String, default: null })
  menuId: string | null;
}
export const StorefrontFooterSchema = SchemaFactory.createForClass(StorefrontFooter);

// The store-identity banner (logo/name/description/rating on the home page)
// is fixed transactional chrome, not a seller-composable section (see the
// storefront plan) — but the seller still needs *some* control over it, so
// these four toggles (not full placement/reordering) are what's actually
// configurable. Defaults all `true` so a store with no saved StoreTheme yet
// (or one saved before this field existed) behaves exactly as before.
@Schema({ _id: false })
export class IdentityBanner {
  @Prop({ type: Boolean, default: true }) showFollowButton: boolean;
  @Prop({ type: Boolean, default: true }) showMessageButton: boolean;
  @Prop({ type: Boolean, default: true }) showLoyaltyButton: boolean;
  @Prop({ type: Boolean, default: true }) showMembershipButton: boolean;

  // ── Layout/visibility around those 4 fixed buttons (Phase 11) — genuinely
  // configurable presentation, not new transactional surface: the buttons
  // above stay individually toggle-able exactly as before; these control
  // everything AROUND them (cover height/composition, which stats show).
  // 'standard' + all-true + null reproduces today's exact rendered look, so
  // an existing store is pixel-identical until a seller changes something.
  @Prop({ type: String, enum: ['standard', 'compact', 'immersive'], default: 'standard' })
  layout: 'standard' | 'compact' | 'immersive';
  @Prop({ type: Boolean, default: true }) showBadges: boolean;
  @Prop({ type: Boolean, default: true }) showFollowerCount: boolean;
  @Prop({ type: Boolean, default: true }) showProductCount: boolean;
  @Prop({ type: Boolean, default: true }) showRating: boolean;
  @Prop({ type: Number, default: null }) descriptionMaxLines: number | null;
}
export const IdentityBannerSchema = SchemaFactory.createForClass(IdentityBanner);

// The draft/live split (Phase 2 of the Store Builder plan) — mirrors the
// `StoreTheme` root shape exactly (theme/header/footer/identityBanner +
// baseThemeId) so every seller edit lands here first and only reaches the
// public storefront once explicitly published. `_id: false` since this is
// always a singleton sub-object, never an array element.
@Schema({ _id: false })
export class StoreThemeDraft {
  @Prop({ type: StorefrontColorsSchema, default: () => ({}) })
  theme: StorefrontColors;

  @Prop({ type: StorefrontHeaderSchema, default: () => ({}) })
  header: StorefrontHeader;

  @Prop({ type: StorefrontFooterSchema, default: () => ({}) })
  footer: StorefrontFooter;

  @Prop({ type: IdentityBannerSchema, default: () => ({}) })
  identityBanner: IdentityBanner;

  @Prop({ type: String, default: null })
  baseThemeId: string | null;

  // Which theme package (a code-shipped `ThemeDefinition`, see
  // `builder/themes/` on the frontend — never a Mongo-stored definition,
  // per the Theme Definition vs. Installed Theme Instance split) this
  // installed row is running. Switching definitions is itself a normal
  // draft→publish action like any other theme edit, so it lives here too
  // (not just at the document root) — see `ThemeVersion.themeDefinitionId`
  // for why a version snapshot also needs to remember it.
  @Prop({ type: String, default: null })
  themeDefinitionId: string | null;

  // Real "developer/advanced authoring" capability #1 — see the class
  // comment on `StoreTheme.customCss` below for the full safety rationale.
  @Prop({ type: String, default: null })
  customCss: string | null;
}
export const StoreThemeDraftSchema = SchemaFactory.createForClass(StoreThemeDraft);

// A real, immutable snapshot of the live theme taken at the moment of every
// `publishTheme()` call — not just a single `lastPublishedAt` timestamp
// pretending to be version history. `_id: true` (Mongoose auto-generates
// one) so the frontend can address a specific version to restore.
@Schema({ _id: true, timestamps: false })
export class ThemeVersion {
  @Prop({ type: StorefrontColorsSchema, default: () => ({}) })
  theme: StorefrontColors;

  @Prop({ type: StorefrontHeaderSchema, default: () => ({}) })
  header: StorefrontHeader;

  @Prop({ type: StorefrontFooterSchema, default: () => ({}) })
  footer: StorefrontFooter;

  @Prop({ type: IdentityBannerSchema, default: () => ({}) })
  identityBanner: IdentityBanner;

  @Prop({ type: String, default: null })
  baseThemeId: string | null;

  @Prop({ type: String, default: null })
  themeDefinitionId: string | null;

  @Prop({ type: String, default: null })
  customCss: string | null;

  @Prop({ type: Date, required: true })
  publishedAt: Date;
}
export const ThemeVersionSchema = SchemaFactory.createForClass(ThemeVersion);

export const INSTALLED_THEME_STATUSES = ['installed', 'active'] as const;
export type InstalledThemeStatus = (typeof INSTALLED_THEME_STATUSES)[number];

// One doc per INSTALLED THEME INSTANCE on a store — site-wide chrome (theme
// colors + header + footer), separate from `StorePage` (per-page section
// content). A store can have several installed rows (Theme Library
// "Install") but exactly one `status: 'active'` at a time (Theme Library
// "Activate") — the public storefront/`getPublic()` always resolves the
// active row. This is the Theme Definition ↔ Installed Theme Instance split:
// `themeDefinitionId` names a code-shipped theme package (frontend
// `builder/themes/<id>/`, never stored in Mongo — theme source is code, not
// merchant data); everything else on this document is the merchant's own
// configuration for that installation, seeded from the definition's defaults
// at install time (`StoreThemeService.installTheme`) and free to diverge
// after that. Replaces `Store.builderConfig` as the source of truth for this
// content; that old field is left as an inert orphan on already-existing
// stores rather than migrated in a big-bang way.
//
// `theme`/`header`/`footer`/`identityBanner`/`baseThemeId`/`themeDefinitionId`
// at the document root are the LIVE/PUBLISHED state for THIS installed row.
// `draft` is the seller's working copy: every
// `updateTheme`/`updateHeader`/`updateFooter`/`updateIdentityBanner` call
// writes here, and only `publishTheme()` copies draft → root — the same
// safe edit-then-publish behavior `StorePage.status` already has, instead of
// every keystroke going instantly live.
//
// Pre-existing stores (from before multi-install) have exactly one row,
// `status: 'active'`, `themeDefinitionId: 'warm-craft'` — see
// `ensureDefaultTheme`'s backfill and `scripts/migrate-installed-themes.ts`
// for the one-time index migration this required (the old schema had a
// single-field unique index on `storeId` alone; a real Mongo deployment
// needs that dropped once so the new compound index below can be created —
// flagged there, not silently assumed).
@Schema({ timestamps: true })
export class StoreTheme {
  _id: string;

  // No standalone index here — the compound `{storeId, themeDefinitionId}`
  // unique index below already serves any storeId-only lookup (Mongo can
  // use a compound index's leading-field prefix), and a redundant same-key
  // single-field index is exactly what caused a real, confirmed incident:
  // an index literally named `storeId_1` was silently recreated with
  // `unique: true` after being dropped, once from a stale process reconnecting
  // with pre-migration schema code — found via live install-theme testing
  // (`E11000 duplicate key error ... storeId_1`). Do not re-add `index: true`
  // here without also confirming it can never collide by name with a
  // legacy/incoming migration.
  @Prop({ required: true })
  storeId: string;

  // Which code-shipped theme package this row is an installation of. Null
  // only for a document written by code that predates this field and hasn't
  // been backfilled yet — `ensureDefaultTheme`/the migration script close
  // that gap; every read path should treat null defensively as
  // `'warm-craft'` rather than crashing.
  @Prop({ type: String, default: null, index: true })
  themeDefinitionId: string | null;

  // Exactly one row per store is `'active'` (enforced in
  // `StoreThemeService.activateTheme`, not by a schema constraint — Mongo
  // has no native "at most one true" index). Every other installed row is
  // `'installed'`: configured and ready, but not what the public storefront
  // renders.
  @Prop({ type: String, enum: INSTALLED_THEME_STATUSES, default: 'active', index: true })
  status: InstalledThemeStatus;

  @Prop({ type: Date, default: () => new Date() })
  installedAt: Date;

  // Merchant-facing override for this INSTALLED ROW's display name — null
  // means "just show the theme package's own name" (today's behavior,
  // unchanged for every pre-existing row). Set automatically to "Copy of X"
  // by `duplicateTheme`, and editable via `renameTheme` — this is what
  // makes two installed rows of the same `themeDefinitionId` (e.g. two
  // Atelier instances, one being experimented on) distinguishable in the
  // Theme Library at all.
  @Prop({ type: String, default: null })
  name: string | null;

  // A real, shareable "see this before it's live" link — Shopify's own
  // preview-link concept, scoped down: the token grants read-only access to
  // this row's DRAFT theme (colors/fonts/buttons/header/footer/customCss)
  // via `GET api/public/store-theme/:storeId/preview/:token`, with NO auth
  // required — matching Shopify's real "visitor preview" (no login needed).
  // Deliberately theme-tokens-only, not real store/product data — building
  // a second parallel token-gated draft-fetch path for every other public
  // endpoint (products, pages, collections) was judged disproportionate for
  // this pass; the disclosed trade-off is a client sees the real branding/
  // colors/navigation, rendered over the theme's own demo content, not the
  // seller's actual live product catalog. One active token at a time —
  // minting a new one invalidates the previous link, matching this
  // codebase's existing "regenerate" convention elsewhere (e.g. webhook
  // secrets) rather than tracking a whole revocable-link history.
  @Prop({ type: PreviewTokenSchema, default: null })
  previewToken: PreviewToken | null;

  @Prop({ type: StorefrontColorsSchema, default: () => ({}) })
  theme: StorefrontColors;

  @Prop({ type: StorefrontHeaderSchema, default: () => ({}) })
  header: StorefrontHeader;

  @Prop({ type: StorefrontFooterSchema, default: () => ({}) })
  footer: StorefrontFooter;

  @Prop({ type: IdentityBannerSchema, default: () => ({}) })
  identityBanner: IdentityBanner;

  // Which curated theme (a frontend-only `themes.ts` definition, not a
  // backend ref/FK) the fields above were last bulk-set FROM — powers the
  // Theme tab's "Currently using X" / "Custom — based on X, N customized"
  // status line. Left untouched by manual field edits, so it keeps meaning
  // "based on X" even after the seller tweaks something. Null for a store
  // that's never applied a gallery theme (pre-existing stores, or a seller
  // who's only ever used the manual controls).
  @Prop({ type: String, default: null })
  baseThemeId: string | null;

  // Real "developer/advanced authoring" capability — a bounded, genuinely
  // safe capability (CSS cannot execute code, read cookies, or make
  // network requests, unlike JS) rather than a fake "Advanced" button that
  // just opens the same merchant editor. Deliberately scoped to CSS only —
  // no custom JS, no custom section-type registration via the UI, no raw
  // theme-source/template editing — because this app has no sandboxing
  // mechanism (no iframe/shadow-DOM isolation for storefront content) that
  // would make arbitrary script execution or new render logic safe to
  // expose to an ordinary merchant. Length-capped and scanned for CSS-level
  // injection vectors (`javascript:` URLs, deprecated IE `expression()`) in
  // `StoreThemeService.validateCustomCss` — real validation, not just a
  // free-text field. There's no separate "theme developer" role in this
  // app's auth model — advanced authoring is an opt-in mode the store's own
  // seller uses on their own store (see `StoreSettings`), not a new RBAC
  // tier; the security boundary is what CSS itself can't do, not a
  // permission check on top of it. Rendered as a raw `<style>` tag in
  // `StorefrontLayout`/Live Preview — unscoped, so a careless rule (e.g.
  // `img { display: none }`) can genuinely break the seller's own storefront
  // layout; that's flagged in the editor UI as a real risk, not hidden.
  @Prop({ type: String, default: null })
  customCss: string | null;

  // Defaults to a copy of the live root fields at read time for any store
  // that predates this field (`ensureDefaultTheme`), never left empty — see
  // that method for why a lazy per-read backfill is safe here (idempotent,
  // no concurrent-writer risk since it's the same $setOnInsert-style upsert
  // pattern already used for the rest of this document).
  @Prop({ type: StoreThemeDraftSchema, default: () => ({}) })
  draft: StoreThemeDraft;

  @Prop({ type: Date, default: null })
  lastPublishedAt: Date | null;

  // Real version history — capped at the most recent 20 publishes (oldest
  // dropped) so this array can't grow unbounded on a store that publishes
  // constantly. Newest last (append-only via $push), reversed for display.
  @Prop({ type: [ThemeVersionSchema], default: [] })
  versions: ThemeVersion[];

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreThemeSchema = SchemaFactory.createForClass(StoreTheme);

// NOT unique — `duplicateTheme` deliberately creates a second row with the
// SAME `themeDefinitionId` (a real, independently-configurable copy, same
// concept as Shopify's own "Duplicate theme"). The single-install-per-
// definition guarantee the old unique index gave is still real, just
// enforced at the application layer instead: `installTheme`'s own
// `findOne({storeId, themeDefinitionId})` idempotency check (unchanged)
// already prevents the *install* flow from ever creating an accidental
// duplicate — a DB-level unique constraint was only ever redundant with
// that check, and became an active blocker once real duplication was a
// real, wanted feature. Still indexed (non-unique) since `{storeId,
// themeDefinitionId}` remains the hot lookup path everywhere in this
// service.
StoreThemeSchema.index({ storeId: 1, themeDefinitionId: 1 });
StoreThemeSchema.index({ storeId: 1, status: 1 });
