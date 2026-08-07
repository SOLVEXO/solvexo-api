/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Block, BlockSchema } from '../../common/schemas/block.schema';

export type StoreThemeDocument = HydratedDocument<StoreTheme>;

@Schema({ _id: false })
export class StorefrontColors {
  @Prop({ type: String, default: '#D97757' }) primaryColor: string;
  @Prop({ type: String, default: '#FAF9F5' }) bgColor: string;
  @Prop({ type: String, default: '#2C2A28' }) textColor: string;
  @Prop({ type: String, default: '#B95A3A' }) accentColor: string;
  @Prop({ type: String, default: 'Poppins' }) font: string;
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
}
export const StorefrontHeaderSchema = SchemaFactory.createForClass(StorefrontHeader);

@Schema({ _id: false })
export class StorefrontFooter {
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[]; // footer_column / social_link / copyright_text blocks
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
}
export const IdentityBannerSchema = SchemaFactory.createForClass(IdentityBanner);

// One doc per store — site-wide chrome (theme colors + header + footer),
// separate from `StorePage` (per-page section content). Replaces
// `Store.builderConfig` as the source of truth for this content; the old
// field is left as an inert orphan on already-existing stores rather than
// migrated in a big-bang way (see `store-theme.service.ts#ensureDefaultTheme`).
@Schema({ timestamps: true })
export class StoreTheme {
  _id: string;

  @Prop({ required: true, unique: true, index: true })
  storeId: string;

  @Prop({ type: StorefrontColorsSchema, default: () => ({}) })
  theme: StorefrontColors;

  @Prop({ type: StorefrontHeaderSchema, default: () => ({}) })
  header: StorefrontHeader;

  @Prop({ type: StorefrontFooterSchema, default: () => ({}) })
  footer: StorefrontFooter;

  @Prop({ type: IdentityBannerSchema, default: () => ({}) })
  identityBanner: IdentityBanner;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreThemeSchema = SchemaFactory.createForClass(StoreTheme);
