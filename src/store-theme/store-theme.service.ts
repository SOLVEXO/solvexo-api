/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateBlocks, HEADER_ALLOWED_BLOCK_TYPES, FOOTER_ALLOWED_BLOCK_TYPES } from '../common/store-content/section-settings.validator';
import { sanitizeCustomCss } from '../common/css-sanitizer';
import { ThemeCatalogService } from '../theme-catalog/theme-catalog.service';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UpdateHeaderDto } from './dto/update-header.dto';
import { UpdateFooterDto } from './dto/update-footer.dto';
import { UpdateIdentityBannerDto } from './dto/update-identity-banner.dto';
import { UpdateCustomCssDto } from './dto/update-custom-css.dto';

const MAX_HEADER_LINKS = 10;
const MAX_FOOTER_BLOCKS = 20;

@Injectable()
export class StoreThemeService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly themeCatalogService: ThemeCatalogService,
  ) {}

  private get storeThemeModel() {
    return this.databaseService.repositories.storeThemeModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }
  private get storePageModel() {
    return this.databaseService.repositories.storePageModel;
  }

  /** Idempotent — called once from `StoreService.createStore()` right after a store is created, and safe to call again (upsert) for the one-off backfill of pre-existing stores. Never called from an unauthenticated read path (see plan: eager creation avoids a public-GET-does-a-write race). */
  async ensureDefaultTheme(storeId: string) {
    await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      { $setOnInsert: { storeId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    // Backfill `draft` = a copy of the live root fields, for any store that
    // predates the draft/publish split. A raw `$exists` filter (not an
    // app-level check on `theme.draft`) is required here — a hydrated
    // Mongoose Document always reports schema defaults for a path missing
    // from the stored document, so there's no way to tell "draft was never
    // set" from "draft was set to all-defaults" once it's been read into JS.
    // No-ops harmlessly (0 matched) for every store that already has a real
    // `draft`, including a brand-new store — `setDefaultsOnInsert` already
    // populated `draft` at insert time above.
    await this.storeThemeModel.updateOne(
      { storeId, draft: { $exists: false } },
      [
        {
          $set: {
            draft: {
              theme: '$theme',
              header: '$header',
              footer: '$footer',
              identityBanner: '$identityBanner',
              baseThemeId: '$baseThemeId',
            },
          },
        },
      ],
      // Mongoose 9 requires this explicit opt-in for an aggregation-pipeline
      // (array) update — without it, `updateOne`/`findOneAndUpdate` throws
      // "Cannot pass an array to query updates unless the `updatePipeline`
      // option is set" for every single call, which is what was breaking
      // `ensureDefaultTheme` (and therefore every theme endpoint AND new
      // store creation, which calls this on every new store) before this fix.
      { updatePipeline: true },
    );
    return this.storeThemeModel.findOne({ storeId });
  }

  async getForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const theme = await this.ensureDefaultTheme(storeId);
    return { success: true, data: theme };
  }

  /** Seller-only working copy, shaped like the public payload (theme/header/footer/identityBanner/baseThemeId) — what Store Builder's Theme/Header/Footer tabs edit, and what Live Preview (Phase 9) renders against real data. */
  async getDraft(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const doc = await this.ensureDefaultTheme(storeId);
    const draft = doc!.draft;
    return {
      success: true,
      data: {
        theme: draft.theme,
        header: draft.header,
        footer: draft.footer,
        identityBanner: draft.identityBanner,
        baseThemeId: draft.baseThemeId,
        // Exposed so Live Preview (`LivePreviewPage.tsx`) can render a
        // pending "Use Theme" home-page composition before it's published —
        // without this, applying a theme would be invisible in preview
        // until the seller committed to Publish.
        pendingHomeSections: draft.pendingHomeSections,
        customCss: draft.customCss,
        lastPublishedAt: doc!.lastPublishedAt,
      },
    };
  }

  async getPublic(storeId: string) {
    const theme = await this.storeThemeModel.findOne({ storeId }).lean();
    return { success: true, data: theme };
  }

  /**
   * Copies draft → the live root fields in one atomic $set, using the same document-referencing aggregation-pipeline update as the draft backfill above (so it can't drift into a two-step read-then-write race).
   *
   * If a Theme Marketplace "Use Theme" is pending (`draft.pendingHomeSections`
   * set by `applyThemeDefinition`, never touched until now), this also writes
   * it into the home `StorePage.sections` and clears the pending field — the
   * one moment a theme's section composition actually reaches the live
   * storefront. Read before the $set so the value isn't lost the instant
   * publishing would otherwise leave it stranded on an already-live draft.
   */
  async publishTheme(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const before = await this.ensureDefaultTheme(storeId);
    const pendingHomeSections = before!.draft?.pendingHomeSections ?? null;

    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      [
        {
          $set: {
            theme: '$draft.theme',
            header: '$draft.header',
            footer: '$draft.footer',
            identityBanner: '$draft.identityBanner',
            baseThemeId: '$draft.baseThemeId',
            customCss: '$draft.customCss',
            lastPublishedAt: '$$NOW',
          },
        },
      ],
      { new: true, updatePipeline: true },
    );

    if (pendingHomeSections) {
      await this.storePageModel.updateOne({ storeId, type: 'home' }, { $set: { sections: pendingHomeSections } });
      await this.storeThemeModel.updateOne({ storeId }, { $set: { 'draft.pendingHomeSections': null } });
    }

    return { success: true, message: 'Theme published', data: updated };
  }

  /** Safety-net "discard unsaved changes" — copies the live root fields back over draft, the mirror image of publishTheme's copy direction. Also clears any not-yet-published `pendingHomeSections` — the live home page was never touched, so there's nothing to revert there, just a pending apply to cancel. */
  async revertDraftToPublished(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      [
        {
          $set: {
            draft: {
              theme: '$theme',
              header: '$header',
              footer: '$footer',
              identityBanner: '$identityBanner',
              baseThemeId: '$baseThemeId',
              customCss: '$customCss',
              pendingHomeSections: null,
            },
          },
        },
      ],
      { new: true, updatePipeline: true },
    );
    return { success: true, message: 'Draft reverted to the published theme', data: updated };
  }

  /**
   * Theme Marketplace "Use Theme" — stages a published `ThemeDefinition`'s
   * colors/header/footer/identity-banner and home-page section composition
   * into this store's draft only. Nothing on the live storefront changes
   * until the seller reviews it in Store Builder and hits Publish (see
   * `publishTheme`) — same safety property every other draft edit already
   * has. The `ThemeDefinition` document itself is never mutated, so applying
   * it to any number of stores can never leak between sellers.
   */
  async applyThemeDefinition(storeId: string, sellerId: string, themeDefinitionId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const current = await this.ensureDefaultTheme(storeId);
    const themeDef = await this.themeCatalogService.getPublishedForApply(themeDefinitionId);

    // Preserve the seller's own nav-link/footer-column content by default —
    // only take the theme's STYLE (`headerStyle`/`footerStyle`/`navAlignment`)
    // unless the theme itself supplies real block content, same
    // seller-respecting behavior the old frontend-only apply flow had
    // (it only ever sent `{headerStyle}`/`{blocks: existingBlocks, footerStyle}`).
    const currentDraft = current!.draft;
    const nextHeader = {
      ...currentDraft.header,
      headerStyle: themeDef.header.headerStyle,
      navAlignment: themeDef.header.navAlignment ?? currentDraft.header.navAlignment,
      blocks: themeDef.header.blocks?.length ? themeDef.header.blocks : currentDraft.header.blocks,
    };
    const nextFooter = {
      ...currentDraft.footer,
      footerStyle: themeDef.footer.footerStyle,
      blocks: themeDef.footer.blocks?.length ? themeDef.footer.blocks : currentDraft.footer.blocks,
    };

    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      {
        $set: {
          'draft.theme': themeDef.theme,
          'draft.header': nextHeader,
          'draft.footer': nextFooter,
          'draft.identityBanner': themeDef.identityBanner,
          'draft.baseThemeId': themeDef._id.toString(),
          'draft.pendingHomeSections': themeDef.homePageSections,
        },
      },
      { new: true },
    );

    await this.themeCatalogService.incrementApplyCount(themeDefinitionId);
    return {
      success: true,
      message: `${themeDef.name} applied to your draft — review it in Store Builder, then Publish to go live`,
      data: updated,
    };
  }

  async updateTheme(storeId: string, sellerId: string, dto: UpdateThemeDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      // `baseThemeId` lives at the draft root (sibling of `theme`), not
      // nested under it — everything else on this DTO is a `theme.*`
      // color/design field. All writes now target `draft.*`, never the
      // live root fields directly — see publishTheme() for how a draft
      // actually goes live.
      set[key === 'baseThemeId' ? 'draft.baseThemeId' : `draft.theme.${key}`] = value;
    }
    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { new: true });
    return { success: true, message: 'Theme updated', data: updated };
  }

  async updateHeader(storeId: string, sellerId: string, dto: UpdateHeaderDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    if (dto.blocks) validateBlocks(dto.blocks, HEADER_ALLOWED_BLOCK_TYPES, MAX_HEADER_LINKS);

    const set: Record<string, unknown> = {};
    if (dto.logoSource !== undefined) set['draft.header.logoSource'] = dto.logoSource;
    if (dto.customLogoUrl !== undefined) set['draft.header.customLogoUrl'] = dto.customLogoUrl;
    if (dto.blocks !== undefined) set['draft.header.blocks'] = dto.blocks;
    if (dto.navAlignment !== undefined) set['draft.header.navAlignment'] = dto.navAlignment;
    if (dto.headerStyle !== undefined) set['draft.header.headerStyle'] = dto.headerStyle;

    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { new: true });
    return { success: true, message: 'Header updated', data: updated };
  }

  async updateFooter(storeId: string, sellerId: string, dto: UpdateFooterDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    validateBlocks(dto.blocks, FOOTER_ALLOWED_BLOCK_TYPES, MAX_FOOTER_BLOCKS);

    const set: Record<string, unknown> = { 'draft.footer.blocks': dto.blocks };
    if (dto.footerStyle !== undefined) set['draft.footer.footerStyle'] = dto.footerStyle;

    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { new: true });
    return { success: true, message: 'Footer updated', data: updated };
  }

  /** Code editor (Phase 5) — sanitized server-side (independent of whatever the client already sanitized) before ever being persisted or rendered. */
  async updateCustomCss(storeId: string, sellerId: string, dto: UpdateCustomCssDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const clean = sanitizeCustomCss(dto.customCss);
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { storeId },
      { $set: { 'draft.customCss': clean } },
      { new: true },
    );
    return { success: true, message: 'Custom CSS updated', data: updated };
  }

  async updateIdentityBanner(storeId: string, sellerId: string, dto: UpdateIdentityBannerDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`draft.identityBanner.${key}`] = value;
    }
    const updated = await this.storeThemeModel.findOneAndUpdate({ storeId }, { $set: set }, { new: true });
    return { success: true, message: 'Store info updated', data: updated };
  }
}
