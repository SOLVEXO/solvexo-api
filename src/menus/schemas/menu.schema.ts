/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MenuDocument = HydratedDocument<Menu>;

// Same 6 link types `nav_link`/`footer_column` blocks already validate
// against (`LINK_TYPES` in `section-settings.validator.ts`) — a menu item
// is the exact same link-target shape, just living in its own reusable,
// named entity instead of being embedded one-off inside a Header/Footer
// block. Kept in sync by hand since this is a different schema file.
export const MENU_LINK_TYPES = ['home', 'page', 'blog', 'external', 'category', 'collection'] as const;
export type MenuLinkType = (typeof MENU_LINK_TYPES)[number];

@Schema({ _id: false })
export class MenuItemChild {
  @Prop({ required: true }) id: string;
  @Prop({ required: true }) label: string;
  @Prop({ type: String, enum: MENU_LINK_TYPES, required: true }) linkType: MenuLinkType;
  @Prop({ type: String, default: null }) pageSlug: string | null;
  @Prop({ type: String, default: null }) url: string | null;
  @Prop({ type: String, default: null }) categoryId: string | null;
  @Prop({ type: String, default: null }) collectionId: string | null;
  @Prop({ type: Boolean, default: false }) highlight: boolean;
}
export const MenuItemChildSchema = SchemaFactory.createForClass(MenuItemChild);

// Single level of nesting only — same constraint `nav_link.children` already
// enforces (both at the TS type level here and at runtime in the service),
// matching this codebase's established "one level of dropdown" convention.
@Schema({ _id: false })
export class MenuItem {
  @Prop({ required: true }) id: string;
  @Prop({ required: true }) label: string;
  @Prop({ type: String, enum: MENU_LINK_TYPES, required: true }) linkType: MenuLinkType;
  @Prop({ type: String, default: null }) pageSlug: string | null;
  @Prop({ type: String, default: null }) url: string | null;
  @Prop({ type: String, default: null }) categoryId: string | null;
  @Prop({ type: String, default: null }) collectionId: string | null;
  @Prop({ type: Boolean, default: false }) highlight: boolean;
  @Prop({ type: [MenuItemChildSchema], default: [] }) children: MenuItemChild[];
}
export const MenuItemSchema = SchemaFactory.createForClass(MenuItem);

/**
 * A store-level, standalone, reusable menu — the real gap this closes: nav
 * links previously lived only embedded one-off inside `StorefrontHeader`/
 * `StorefrontFooter` blocks, so a seller couldn't build a menu once and
 * reuse or reference it, and there was no menu concept independent of
 * "the Header's own blocks." Genuinely mirrors Shopify's Content → Menus.
 *
 * Header attachment (see `StorefrontHeader.menuId` on `store-theme.schema.ts`)
 * was the first consumer: when a menu is attached, the storefront renders
 * ITS items instead of the Header's own inline `nav_link` blocks — resolved
 * at read time in `StoreThemeService.resolveHeaderMenu` into the exact same
 * `Block` shape the renderer already knows how to draw, so zero changes were
 * needed in either theme's Navbar component. Footer attachment
 * (`StorefrontFooter.menuId`, `StoreThemeService.resolveFooterMenu`) follows
 * the same idea but its own mapping, since footer blocks mix
 * `footer_column`/`social_link`/`copyright_text`, not just links: the
 * resolved menu becomes one synthetic `footer_column` block instead of
 * wholesale replacing `blocks`.
 */
@Schema({ timestamps: true })
export class Menu {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: [MenuItemSchema], default: [] })
  items: MenuItem[];

  createdAt?: Date;
  updatedAt?: Date;
}

export const MenuSchema = SchemaFactory.createForClass(Menu);
MenuSchema.index({ storeId: 1, name: 1 });
