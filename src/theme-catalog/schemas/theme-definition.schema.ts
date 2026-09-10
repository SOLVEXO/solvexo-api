/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  StorefrontColors,
  StorefrontColorsSchema,
  StorefrontHeader,
  StorefrontHeaderSchema,
  StorefrontFooter,
  StorefrontFooterSchema,
  IdentityBanner,
  IdentityBannerSchema,
} from '../../store-theme/schemas/store-theme.schema';
import { Section, SectionSchema } from '../../common/schemas/section.schema';

export type ThemeDefinitionDocument = HydratedDocument<ThemeDefinition>;

// Exactly the 11 categories the theme marketplace is organized around —
// distinct from (and a superset in spirit of) the older, narrower 7-value
// frontend-only `ThemeCategory` in `builder/themes.ts`, which this catalog
// supersedes as the source of truth once Phase 4 re-points the gallery at it.
export const THEME_CATALOG_CATEGORIES = [
  'fashion',
  'beauty',
  'electronics',
  'jewelry',
  'furniture',
  'food',
  'restaurant',
  'education',
  'digital_products',
  'services',
  'general',
] as const;
export type ThemeCatalogCategory = (typeof THEME_CATALOG_CATEGORIES)[number];

/**
 * One admin-managed, global theme in the marketplace catalog. A seller never
 * mutates this document — "applying" a theme (see
 * `StoreThemeService.applyThemeDefinition`) copies these fields into the
 * seller's own `StoreTheme.draft`/home `StorePage`, so isolation between
 * sellers who picked the same theme falls out of the existing per-store
 * ownership model for free, with no separate "theme instance" collection.
 *
 * Deliberately reuses the exact sub-schemas a seller already edits by hand
 * (`StorefrontColors`/`StorefrontHeader`/`StorefrontFooter`/`IdentityBanner`
 * from `store-theme.schema.ts`, and `Section` from `common/schemas/section.schema.ts`)
 * rather than redefining an equivalent shape — a theme's design tokens and
 * home-page composition round-trip through the exact same validators/
 * renderers a hand-built store already uses.
 */
@Schema({ timestamps: true })
export class ThemeDefinition {
  _id: string;

  @Prop({ required: true, unique: true, index: true })
  slug: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, default: '' })
  description: string;

  @Prop({ type: String, enum: THEME_CATALOG_CATEGORIES, required: true, index: true })
  category: ThemeCatalogCategory;

  @Prop({ type: [String], default: [] })
  tags: string[];

  // Bumped by an admin edit that changes content, not auto-incremented per
  // save — purely informational (shown on the Theme Detail page), not a
  // snapshot/history mechanism (see the plan: versioning stays at the
  // existing draft/publish/revert depth, no per-version storage here).
  @Prop({ type: Number, default: 1 })
  version: number;

  @Prop({ type: String, default: null })
  thumbnail: string | null;

  @Prop({ type: [String], default: [] })
  screenshots: string[];

  @Prop({ type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true })
  status: 'draft' | 'published' | 'archived';

  @Prop({ type: Boolean, default: false, index: true })
  featured: boolean;

  // Admin-set merchandising badge for the gallery card — sparingly assigned,
  // most themes have none. Purely presentational, not derived from
  // view/apply counters (an admin decides what's genuinely "new"/"popular").
  @Prop({ type: String, enum: ['new', 'popular', 'trending'], default: null })
  badge: 'new' | 'popular' | 'trending' | null;

  @Prop({ type: String, enum: ['free', 'premium'], default: 'free' })
  tier: 'free' | 'premium';

  @Prop({ type: StorefrontColorsSchema, default: () => ({}) })
  theme: StorefrontColors;

  @Prop({ type: StorefrontHeaderSchema, default: () => ({}) })
  header: StorefrontHeader;

  @Prop({ type: StorefrontFooterSchema, default: () => ({}) })
  footer: StorefrontFooter;

  @Prop({ type: IdentityBannerSchema, default: () => ({}) })
  identityBanner: IdentityBanner;

  // The seeded home-page composition — what makes a theme structurally
  // distinct (section choice/order/copy), not just a color/style recolor.
  // Same `Section` shape `StorePage.sections` already uses, so it is
  // validated by, and renders through, the exact same machinery.
  @Prop({ type: [SectionSchema], default: [] })
  homePageSections: Section[];

  // Simple counters, not a separate analytics pipeline — enough for the
  // Admin Theme Management "views/applications" columns the plan calls for.
  @Prop({ type: Number, default: 0 })
  viewCount: number;

  @Prop({ type: Number, default: 0 })
  applyCount: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ThemeDefinitionSchema = SchemaFactory.createForClass(ThemeDefinition);
ThemeDefinitionSchema.index({ status: 1, category: 1 });
ThemeDefinitionSchema.index({ status: 1, featured: 1 });
