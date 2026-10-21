/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Block, BlockSchema } from '../../common/schemas/block.schema';
import { Section, SectionSchema } from '../../common/schemas/section.schema';

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
  // Optional extra roles; absent = the theme derives them from the three above.
  @Prop({ type: String, default: null }) mutedColor: string | null;
  @Prop({ type: String, default: null }) borderColor: string | null;
  @Prop({ type: String, default: null }) saleColor: string | null;
}
export const ColorSchemeSchema = SchemaFactory.createForClass(ColorScheme);

@Schema({ _id: false })
export class StorefrontColors {
  @Prop({ type: String, default: '#D97757' }) primaryColor: string;
  @Prop({ type: String, default: '#FAF9F5' }) bgColor: string;
  @Prop({ type: String, default: '#2C2A28' }) textColor: string;
  @Prop({ type: String, default: '#B95A3A' }) accentColor: string;
  @Prop({ type: String, default: 'Poppins' }) font: string;
  @Prop({ type: String, default: null }) headingFont: string | null;
  // Optional overrides for colours the theme otherwise derives (null = auto).
  @Prop({ type: String, default: null }) mutedColor: string | null;
  @Prop({ type: String, default: null }) borderColor: string | null;
  @Prop({ type: String, default: null }) saleColor: string | null;
  // Typography / shape options a theme may read (a theme ignores any it does not support).
  @Prop({ type: String, enum: ['regular', 'medium', 'semibold', 'bold'], default: 'medium' }) headingWeight: string;
  @Prop({ type: String, enum: ['none', 'uppercase'], default: 'none' }) headingCase: string;
  @Prop({ type: String, enum: ['auto', 'tight', 'normal', 'wide'], default: 'auto' }) headingTracking: string;
  @Prop({ type: String, enum: ['normal', 'uppercase'], default: 'normal' }) buttonCase: string;
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large'], default: 'large' }) sectionRadius: string;
  @Prop({ type: String, enum: ['none', 'small', 'medium', 'large', 'full'], default: 'medium' }) inputRadius: string;
  @Prop({ type: String, enum: ['pill', 'square'], default: 'pill' }) badgeStyle: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) cardRating: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) cardTag: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) cardButton: string;
  @Prop({ type: String, enum: ['small', 'medium', 'large', 'xlarge'], default: 'medium' }) headingScale: string;
  @Prop({ type: String, enum: ['small', 'medium', 'large'], default: 'medium' }) bodyScale: string;
  @Prop({ type: String, enum: ['auto', 'tight', 'normal', 'loose'], default: 'auto' }) headingLineHeight: string;
  @Prop({ type: String, enum: ['auto', 'always', 'never'], default: 'auto' }) linkUnderline: string;
  @Prop({ type: String, enum: ['narrow', 'standard', 'wide'], default: 'standard' }) pagePadding: string;
  @Prop({ type: String, enum: ['tight', 'standard', 'airy'], default: 'standard' }) gridGap: string;
  @Prop({ type: String, enum: ['fade', 'lift', 'grow'], default: 'fade' }) buttonHover: string;
  @Prop({ type: String, enum: ['none', 'soft'], default: 'none' }) buttonShadow: string;
  @Prop({ type: String, enum: ['shadow', 'lift', 'none'], default: 'shadow' }) cardHover: string;
  @Prop({ type: String, enum: ['left', 'center'], default: 'left' }) cardTextAlign: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) showBreadcrumbs: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) showStockStatus: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) showVendor: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) showReviews: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) stickyBuyBar: string;
  @Prop({ type: String, enum: ['on', 'off'], default: 'on' }) animations: string;
  @Prop({ type: String, enum: ['auto', 'accent', 'ink'], default: 'auto' }) focusRing: string;
  @Prop({ type: String, enum: ['regular', 'medium'], default: 'regular' }) bodyWeight: string;
  @Prop({ type: String, enum: ['none', 'line'], default: 'none' }) sectionDividers: string;
  @Prop({ type: String, enum: ['auto', 'accent'], default: 'auto' }) selection: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) cardWishlist: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) cardViewLink: string;
  @Prop({ type: String, enum: ['percent', 'label'], default: 'percent' }) saleBadgeText: string;
  @Prop({ type: String, enum: ['show', 'hide'], default: 'show' }) showDelivery: string;
  @Prop({ type: String, default: null }) headingColor: string | null;
  @Prop({ type: String, default: null }) linkColor: string | null;
  @Prop({ type: String, default: null }) priceColor: string | null;
  @Prop({ type: String, default: null }) starColor: string | null;
  @Prop({ type: String, default: null }) successColor: string | null;
  @Prop({ type: String, default: null }) buttonTextColor: string | null;
  @Prop({ type: String, default: null }) cardBgColor: string | null;
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

  @Prop({ type: String, enum: ['square', 'portrait', 'landscape', 'adapt'], default: 'square' })
  productImageRatio: 'square' | 'portrait' | 'landscape' | 'adapt';

  @Prop({ type: String, enum: ['none', 'zoom', 'second-image'], default: 'none' })
  productImageHover: 'none' | 'zoom' | 'second-image';

  // No defaults: unset = the theme's own look (badges shown, theme card, cart drawer).
  @Prop({ type: String, enum: ['show', 'hide'] })
  saleBadge?: 'show' | 'hide';
  // Quick view button on product cards; unset = the theme's own default.
  @Prop({ type: String, enum: ['show', 'hide'] })
  quickView?: 'show' | 'hide';
  // Colour swatches on product cards; unset = the theme's own default.
  @Prop({ type: String, enum: ['show', 'hide'] })
  colorSwatches?: 'show' | 'hide';
  // Settings a theme declares in its own manifest (`custom.<name>` fields). The backend stores them without knowing the
  // theme: adding a setting to a theme needs no schema or DTO change. Shape/size is enforced by the DTO.
  @Prop({ type: Object, default: undefined })
  themeSettings?: Record<string, string | number | boolean>;
  @Prop({ type: String, enum: ['show', 'hide'] })
  soldOutBadge?: 'show' | 'hide';
  @Prop({ type: String, enum: ['theme', 'flat', 'outlined', 'elevated'] })
  cardStyle?: 'theme' | 'flat' | 'outlined' | 'elevated';
  @Prop({ type: String, enum: ['drawer', 'page'] })
  cartType?: 'drawer' | 'page';

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
  @Prop({ type: Object, default: null }) logoLink: Record<string, unknown> | null; // where the logo goes; null = home page
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[]; // nav_link blocks only
  // Extra full-width sections shown under the header bar (promo strip, trust row...); the seller adds/reorders them like page sections.
  @Prop({ type: [SectionSchema], default: [] }) sections: Section[];
  // Where the nav-link group sits relative to the logo — the icons (cart/
  // account) always stay pinned to the far right regardless of this.
  @Prop({ type: String, enum: ['left', 'center', 'right'], default: 'left' })
  navAlignment: 'left' | 'center' | 'right';
  // Overall header composition — 'standard' is today's logo-left/inline-nav
  // layout; 'centered' stacks a centered logo with nav below it.
  // 'split' = menu left, logo centre, icons right; 'inline' = logo left, menu centred, icons right.
  @Prop({ type: String, enum: ['standard', 'centered', 'split', 'inline'], default: 'standard' })
  headerStyle: 'standard' | 'centered' | 'split' | 'inline';
  // Independent layout controls (null = derive from `headerStyle`, the older combined choice).
  @Prop({ type: String, enum: ['left', 'center', 'right'], default: null }) logoPosition: 'left' | 'center' | 'right' | null;
  @Prop({ type: String, enum: ['beside', 'below'], default: null }) menuPosition: 'beside' | 'below' | null;
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
  // Retailer-controlled header chrome. Every field defaults to today's look, so a store saved
  // before these existed renders exactly as before (the storefront reads a missing value as the default).
  @Prop({ type: Number, default: null }) logoWidth: number | null;        // px; null = the theme's own max-height behaviour
  @Prop({ type: Number, default: null }) mobileLogoWidth: number | null;  // px; null = same as desktop (capped)
  @Prop({ type: Boolean, default: false }) sticky: boolean;
  @Prop({ type: Boolean, default: true }) showSearch: boolean;
  @Prop({ type: Boolean, default: true }) showAccount: boolean;
  @Prop({ type: Boolean, default: true }) showWishlist: boolean;
  @Prop({ type: Boolean, default: true }) showShopMenu: boolean;          // the auto "Shop" dropdown (categories + collections)
  @Prop({ type: String, default: null }) shopMenuLabel: string | null;    // null = "Shop"
  @Prop({ type: Boolean, default: true }) includePagesInNav: boolean;     // pages flagged "show in navigation"
  @Prop({ type: Boolean, default: true }) showDefaultBlogLink: boolean;   // the theme's Journal/Stories link when the nav is empty
  @Prop({ type: String, default: null }) blogLinkLabel: string | null;
  @Prop({ type: String, default: null }) bgColor: string | null;          // null = theme colour
  @Prop({ type: String, default: null }) textColor: string | null;
  @Prop({ type: String, enum: ['compact', 'normal', 'spacious'], default: 'normal' }) paddingY: 'compact' | 'normal' | 'spacious';
  @Prop({ type: Boolean, default: true }) showDivider: boolean;
  // Premium header controls; every default reproduces the earlier look.
  @Prop({ type: String, enum: ['off', 'always', 'scroll-up'], default: null }) stickyMode: 'off' | 'always' | 'scroll-up' | null; // null = follow `sticky`
  @Prop({ type: Boolean, default: false }) transparentOnHome: boolean;
  @Prop({ type: String, default: null }) transparentTextColor: string | null;
  @Prop({ type: String, enum: ['sm', 'md', 'lg'], default: 'md' }) navFontSize: 'sm' | 'md' | 'lg';
  @Prop({ type: Boolean, default: false }) navUppercase: boolean;
  @Prop({ type: String, enum: ['none', 'underline', 'pill'], default: 'none' }) navHoverStyle: 'none' | 'underline' | 'pill';
  @Prop({ type: String, enum: ['icon', 'bar'], default: 'icon' }) searchStyle: 'icon' | 'bar';
  @Prop({ type: String, default: 'icons' }) searchPosition: string; // bar only: next to the icons, or centered on its own row
  @Prop({ type: String, default: null }) ctaLabel: string | null;
  @Prop({ type: String, default: null }) ctaLink: string | null;
  @Prop({ type: Boolean, default: false }) topBarEnabled: boolean;
  @Prop({ type: String, default: null }) topBarText: string | null;
  @Prop({ type: String, default: null }) topBarPhone: string | null;
  @Prop({ type: String, default: null }) topBarEmail: string | null;
  @Prop({ type: String, default: null }) topBarBg: string | null;
  @Prop({ type: String, default: null }) topBarTextColor: string | null;
  @Prop({ type: String, default: null }) preset: string | null;
}
export const StorefrontHeaderSchema = SchemaFactory.createForClass(StorefrontHeader);

@Schema({ _id: false })
export class StorefrontFooter {
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[]; // footer_column / social_link / copyright_text blocks
  // Extra full-width sections shown above the footer panel (newsletter, testimonials, logos...).
  @Prop({ type: [SectionSchema], default: [] }) sections: Section[];
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
  // Retailer-controlled footer chrome — defaults reproduce the footer as it was before these existed.
  @Prop({ type: String, enum: ['none', 'store', 'custom'], default: 'none' }) logoSource: 'none' | 'store' | 'custom';
  @Prop({ type: String, default: null }) logoUrl: string | null;
  @Prop({ type: Object, default: null }) logoLink: Record<string, unknown> | null; // where the footer logo goes; null = home page
  @Prop({ type: Number, default: null }) logoWidth: number | null;
  @Prop({ type: Boolean, default: true }) showNewsletter: boolean;
  @Prop({ type: String, default: null }) newsletterHeading: string | null;
  @Prop({ type: String, default: null }) newsletterText: string | null;
  @Prop({ type: Boolean, default: true }) showDefaultColumns: boolean;    // the built-in Shop / Account columns when no column blocks exist
  @Prop({ type: String, default: null }) shopColumnHeading: string | null;
  @Prop({ type: String, default: null }) accountColumnHeading: string | null;
  @Prop({ type: String, default: null }) blogLinkLabel: string | null;
  @Prop({ type: String, default: null }) bgColor: string | null;
  @Prop({ type: String, default: null }) textColor: string | null;
  // true once the footer is saved as an ordered block list (brand + newsletter are blocks); false = older layout.
  @Prop({ type: Boolean, default: false }) blockLayout: boolean;
  // Premium footer controls; every default reproduces the earlier look.
  @Prop({ type: String, enum: ['compact', 'normal', 'spacious'], default: 'normal' }) paddingY: 'compact' | 'normal' | 'spacious';
  @Prop({ type: String, default: null }) bgImageUrl: string | null;
  @Prop({ type: Number, default: 50 }) bgOverlay: number;              // 0–85 % darkness over the image
  @Prop({ type: String, enum: ['left', 'center'], default: 'left' }) align: 'left' | 'center';
  @Prop({ type: Boolean, default: true }) headingUppercase: boolean;
  @Prop({ type: String, enum: ['plain', 'circle', 'square'], default: null }) socialStyle: 'plain' | 'circle' | 'square' | null; // null = theme
  // Social icon colour: null = the theme's own, 'brand' = each platform's real colour, 'custom' = socialCustomColor.
  @Prop({ type: String, enum: ['brand', 'custom'], default: null }) socialColor: 'brand' | 'custom' | null;
  @Prop({ type: String, default: null }) socialCustomColor: string | null;
  // true = the button is filled with the full colour and the icon is white/dark; false = a soft tint with a coloured icon.
  @Prop({ type: Boolean, default: false }) socialFilled: boolean;
  // Width and height of one social icon button in px (24–72); null = the theme's own size.
  @Prop({ type: Number, default: null }) socialSize: number | null;
  @Prop({ type: Boolean, default: false }) newsletterTop: boolean;     // Email sign-up as a wide strip above the columns
  @Prop({ type: Boolean, default: true }) mobileAccordion: boolean;    // columns fold on phones
  @Prop({ type: Boolean, default: true }) showPolicyLinks: boolean;
  @Prop({ type: Boolean, default: false }) showCurrency: boolean;
  @Prop({ type: Boolean, default: false }) showBackToTop: boolean;
  @Prop({ type: String, default: null }) preset: string | null;
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

  // Which theme package (a code-shipped `NEW_THEME_REGISTRY` key — see
  // `storefront-themes/registry.ts` on the frontend, e.g. 'theme-03-fashion'
  // — never a Mongo-stored definition) this installed row's REACT CODE is.
  // Mirrors the document root's own `themeDefinitionId` exactly and should
  // never diverge from it outside of `ensureDefaultTheme`'s legacy backfill
  // — nothing in the draft/publish flow is meant to change *which code*
  // renders a storefront; only Theme Library's install/activate does that.
  // Do NOT write a `ThemeDefinition` catalog id here (see
  // `appliedCatalogThemeId` below for that) — this exact field previously
  // collided with a catalog id via `StoreThemeService.applyThemeDefinition`,
  // confirmed live to corrupt the document root's own `themeDefinitionId` on
  // the next publish, silently flipping which theme's code a storefront
  // renders.
  @Prop({ type: String, default: null })
  themeDefinitionId: string | null;

  // A `ThemeDefinition` (admin theme-catalog) Mongo `_id`, staged here by
  // `StoreThemeService.applyThemeDefinition` when a seller applies a
  // catalog theme's colors/header/footer/home-sections. Deliberately its
  // own field, in its own ID namespace, so it can never be confused with —
  // or overwrite — `themeDefinitionId` above (a fixed code-registry key).
  // Purely informational today (no current frontend reads it — the
  // seller-facing catalog "browse and apply" UI isn't wired up yet); a
  // future Theme Library surface for the catalog can read this to show
  // "applied but not yet published."
  @Prop({ type: String, default: null })
  appliedCatalogThemeId: string | null;

  // Staged by `StoreThemeService.applyThemeDefinition` — a theme's home-page
  // composition can't be committed straight to the live `StorePage` the
  // moment a seller picks a theme (that would bypass the draft/publish
  // review step every other theme edit goes through), so it waits here
  // until the seller's next `publishTheme()` call, which writes it into the
  // home `StorePage.sections` and clears this field. `null` (not `[]`) is
  // the "nothing pending" state, distinct from a theme that legitimately
  // ships zero home sections.
  @Prop({ type: [SectionSchema], default: null })
  pendingHomeSections: Section[] | null;
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

  @Prop({ type: Number, default: null })
  sourcePackageVersion: number | null;

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
  // Maison instances, one being experimented on) distinguishable in the
  // Theme Library at all.
  @Prop({ type: String, default: null })
  name: string | null;

  // A real, shareable "see this before it's live" link — Shopify's own
  // preview-link concept, scoped down: the token grants read-only access to
  // this row's DRAFT theme (colors/fonts/buttons/header/footer)
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
