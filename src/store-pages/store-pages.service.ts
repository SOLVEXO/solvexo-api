/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateSectionSettings, validateBlocksOfType, SECTION_ALLOWED_BLOCK_TYPES } from '../common/store-content/section-settings.validator';
import { sectionAcceptsAppBlocks } from '../common/store-content/app-block.util';
import { SectionType } from '../common/schemas/section.schema';
import { ContentVersioningService } from '../common/content-versioning/content-versioning.service';
import { AppsService } from '../apps/apps.service';
import { MetafieldsService } from '../metafields/metafields.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { UpdateSectionsDto } from './dto/update-sections.dto';
import { assertThemeSupportsSections, filterSectionsToTheme } from '../common/store-content/theme-section-capabilities';

const MAX_SECTIONS_PER_PAGE = 40;
// Custom pages are served at the bare `/:slug/:pageSlug` (no `/pages/`
// prefix), so a page slug now shares its namespace directly with sibling
// storefront routes — 'blog' must be reserved to avoid shadowing
// `/:slug/blog`. 'home' stays reserved since the home page's own slug is
// always the fixed empty string, never seller-assignable. 'category'/
// 'collections' reserved alongside the new store-scoped category-browse
// (`/category/:slugOrId`) and collection-detail (`/collections/:slugOrId`)
// storefront routes (Store Builder plan, Phase 11) for the same reason.
// 'search' reserved for the navbar search box's results route.
const RESERVED_CUSTOM_PAGE_SLUGS = ['home', 'blog', 'category', 'collections', 'product', 'search', 'cart', 'checkout', 'login', 'register', 'verify-otp', 'forgot-password', 'new-password', 'account', 'wishlist', 'loyalty', 'messages', 'notifications', 'returns', 'gift-cards', 'subscriptions'];

function validateSections(sections: { type: SectionType; settings: Record<string, any>; blocks: { type: string; settings: Record<string, any> }[] }[]) {
  if (sections.length > MAX_SECTIONS_PER_PAGE) {
    throw new BadRequestException(`A page cannot have more than ${MAX_SECTIONS_PER_PAGE} sections`);
  }
  for (const section of sections) {
    validateSectionSettings(section.type, section.settings ?? {});
    validateBlocksOfType(section.blocks ?? [], SECTION_ALLOWED_BLOCK_TYPES[section.type], sectionAcceptsAppBlocks(section.type));
  }
}

/** Public (anonymous) reads must never expose unpublished work: `draft` and `versions` hold unreleased edits and history. */
export function stripUnpublished<T extends Record<string, any>>(page: T): Omit<T, 'draft' | 'versions' | 'themeTemplates'> {
  const { draft: _draft, versions: _versions, themeTemplates: _themeTemplates, ...rest } = page as any;
  return rest;
}

function starterHomeSections() {
  return [
    { type: 'hero' as SectionType, settings: { heightPreset: 'medium' }, blocks: [] },
    { type: 'product_catalog' as SectionType, settings: { heading: 'Our Products' }, blocks: [] },
  ];
}

@Injectable()
export class StorePagesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly contentVersioningService: ContentVersioningService,
    private readonly appsService: AppsService,
    private readonly metafieldsService: MetafieldsService,
  ) {}

  private get storePageModel() {
    return this.databaseService.repositories.storePageModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }
  private get storeThemeModel() {
    return this.databaseService.repositories.storeThemeModel;
  }

  private async resolveInstalledThemeId(storeId: string, installedThemeId?: string): Promise<string | undefined> {
    if (!this.storeThemeModel) return undefined;
    const query = installedThemeId
      ? { _id: installedThemeId, storeId }
      : { storeId, status: 'active' };
    const theme = await this.storeThemeModel.findOne(query).select('_id themeDefinitionId').lean();
    if (!theme && installedThemeId) throw new NotFoundException('Installed theme not found');
    return theme?._id ? String(theme._id) : undefined;
  }

  private async ensurePageThemeTemplate(page: any, installedThemeId?: string) {
    if (!installedThemeId) return page;
    if (page.themeTemplates?.some((template: any) => String(template.installedThemeId) === installedThemeId)) return page;

    const theme = await this.storeThemeModel.findOne({ _id: installedThemeId, storeId: page.storeId }).select('themeDefinitionId').lean();
    if (!theme) throw new NotFoundException('Installed theme not found');
    if (!theme.themeDefinitionId) throw new BadRequestException('The installed theme has no registered section capabilities');
    const liveSections = filterSectionsToTheme(page.sections ?? [], theme.themeDefinitionId);
    const draftSections = filterSectionsToTheme(page.draft?.sections ?? page.sections ?? [], theme.themeDefinitionId);
    await this.storePageModel.updateOne(
      { _id: page._id, storeId: page.storeId, 'themeTemplates.installedThemeId': { $ne: installedThemeId } },
      { $push: { themeTemplates: {
        installedThemeId,
        sections: liveSections,
        draftSections,
        lastPublishedAt: page.lastPublishedAt ?? null,
        versions: Array.isArray(page.versions) ? page.versions : [],
      } } },
    );
    return this.storePageModel.findOne({ _id: page._id, storeId: page.storeId, isDelete: false });
  }

  private async presentPageForTheme(page: any, installedThemeId?: string) {
    const themed = await this.ensurePageThemeTemplate(page, installedThemeId);
    if (!installedThemeId) return themed;
    const plain = typeof themed?.toObject === 'function' ? themed.toObject() : { ...themed };
    const template = plain.themeTemplates?.find((entry: any) => String(entry.installedThemeId) === installedThemeId);
    const { themeTemplates: _themeTemplates, ...safePage } = plain;
    return {
      ...safePage,
      installedThemeId,
      sections: template?.sections ?? plain.sections,
      draft: { ...(plain.draft ?? {}), sections: template?.draftSections ?? plain.draft?.sections ?? plain.sections },
      lastPublishedAt: template?.lastPublishedAt ?? plain.lastPublishedAt,
      versions: template?.versions ?? plain.versions,
    };
  }

  /** Idempotent — called from `StoreService.createStore()` right after creation, and from the one-off backfill script for pre-existing stores. A brand-new home page starts as a usable draft with a hero + product catalog, not empty — its `draft.sections` starts identical to `sections`, since there's nothing yet to diverge. */
  /** Root-cause fix: this used to seed a new store's home page at
   *  `status: 'draft'` — real starter content (`starterHomeSections()`) sat
   *  in both `sections` AND `draft.sections`, but `getPublicHome` only ever
   *  serves a `status: 'published'` doc, so a brand-new store's live
   *  storefront had literally nothing to show — no theme/home page ever
   *  looked "active" — until the seller happened to open the Theme Editor
   *  and click Publish once. Shopify's own default theme (Horizon) is live
   *  the instant a store exists, with zero manual publish step required;
   *  this makes Solvexo match that. The seller's OWN edits still go through
   *  the normal draft→Publish cycle exactly as before — only the initial
   *  seed state changes from draft to already-published, mirroring exactly
   *  what `publish()` itself sets (`status`+`lastPublishedAt`) below. */
  async ensureHomePage(storeId: string) {
    return this.storePageModel.findOneAndUpdate(
      { storeId, type: 'home' },
      {
        $setOnInsert: {
          storeId,
          type: 'home',
          slug: '',
          title: 'Home',
          sections: starterHomeSections(),
          draft: { sections: starterHomeSections() },
          status: 'published',
          lastPublishedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  /** See `ContentVersioningService#backfillDraft` — any page saved before the draft/publish split gets `draft.sections` seeded from its live `sections` the first time it's touched, never left at the schema-default empty array. */
  private async backfillPageDrafts(filter: Record<string, unknown>) {
    await this.contentVersioningService.backfillDraft(this.storePageModel, filter, 'draft', {
      sections: '$sections',
    });
  }

  private async findOwnedPage(storeId: string, sellerId: string, pageId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.backfillPageDrafts({ _id: pageId, storeId });
    const page = await this.storePageModel.findOne({ _id: pageId, storeId, isDelete: false });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  // ── Seller ───────────────────────────────────────────────────────────────

  async listForSeller(storeId: string, sellerId: string, requestedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureHomePage(storeId);
    await this.backfillPageDrafts({ storeId });
    const [pages, installedThemeId] = await Promise.all([
      this.storePageModel.find({ storeId, isDelete: false }).sort({ type: -1, createdAt: 1 }).lean(),
      this.resolveInstalledThemeId(storeId, requestedThemeId),
    ]);
    return { success: true, data: await Promise.all(pages.map(page => this.presentPageForTheme(page, installedThemeId))) };
  }

  async getForSeller(storeId: string, sellerId: string, pageId: string, installedThemeId?: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    const themeId = await this.resolveInstalledThemeId(storeId, installedThemeId);
    return { success: true, data: await this.presentPageForTheme(page, themeId) };
  }

  /** The seller editor's actual working copy — `draft.sections` plus enough context (`lastPublishedAt`) to show a "you have unpublished changes" state. Mirrors `StoreThemeService#getDraft`'s shape/purpose. */
  async getDraft(storeId: string, sellerId: string, pageId: string, installedThemeId?: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    const themeId = await this.resolveInstalledThemeId(storeId, installedThemeId);
    const current = await this.presentPageForTheme(page, themeId);
    return {
      success: true,
      data: {
        sections: current.draft.sections,
        lastPublishedAt: current.lastPublishedAt,
      },
    };
  }

  async createPage(storeId: string, sellerId: string, dto: CreatePageDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    if (RESERVED_CUSTOM_PAGE_SLUGS.includes(dto.slug)) {
      throw new BadRequestException(`"${dto.slug}" is a reserved page slug — choose another`);
    }
    const existing = await this.storePageModel.findOne({ storeId, slug: dto.slug, isDelete: false });
    if (existing) throw new ConflictException(`A page with slug "${dto.slug}" already exists`);

    const page = await this.storePageModel.create({
      storeId,
      type: 'custom',
      slug: dto.slug,
      title: dto.title,
      sections: [],
      draft: { sections: [] },
      status: 'draft',
    });
    return { success: true, message: 'Page created', data: page };
  }

  async updatePage(storeId: string, sellerId: string, pageId: string, dto: UpdatePageDto) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    if (dto.slug !== undefined && page.type === 'home') {
      throw new BadRequestException('The home page slug cannot be changed');
    }
    if (dto.slug !== undefined && dto.slug !== page.slug) {
      if (RESERVED_CUSTOM_PAGE_SLUGS.includes(dto.slug)) {
        throw new BadRequestException(`"${dto.slug}" is a reserved page slug — choose another`);
      }
      const conflict = await this.storePageModel.findOne({ storeId, slug: dto.slug, isDelete: false, _id: { $ne: pageId } });
      if (conflict) throw new ConflictException(`A page with slug "${dto.slug}" already exists`);
    }

    if (dto.policyType !== undefined && dto.policyType !== null && dto.policyType !== page.policyType) {
      // Same "at most one" rule the schema's partial unique index also
      // enforces (belt-and-suspenders) — checked here first so a conflict
      // comes back as a clear 409 instead of a raw duplicate-key error.
      const conflict = await this.storePageModel.findOne({
        storeId, policyType: dto.policyType, isDelete: false, _id: { $ne: pageId },
      });
      if (conflict) {
        throw new ConflictException(`"${conflict.title}" is already this store's ${dto.policyType.replace(/_/g, ' ')} — untag it first`);
      }
    }

    const set: Record<string, unknown> = {};
    if (dto.title !== undefined) set.title = dto.title;
    if (dto.slug !== undefined) set.slug = dto.slug;
    if (dto.showInNav !== undefined) set.showInNav = dto.showInNav;
    if (dto.showInFooter !== undefined) set.showInFooter = dto.showInFooter;
    if (dto.policyType !== undefined) set.policyType = dto.policyType;
    if (dto.seo?.metaTitle !== undefined) set['seo.metaTitle'] = dto.seo.metaTitle;
    // `metaDesc` is a deprecated write-compat alias — a caller still only
    // sending it (not yet updated to `metaDescription`) still lands in the
    // real, full-parity field, not just the legacy one, so read paths never
    // need to check both once anything has been saved through here again.
    if (dto.seo?.metaDescription !== undefined) set['seo.metaDescription'] = dto.seo.metaDescription;
    else if (dto.seo?.metaDesc !== undefined) set['seo.metaDescription'] = dto.seo.metaDesc;
    if (dto.seo?.metaDesc !== undefined) set['seo.metaDesc'] = dto.seo.metaDesc;
    if (dto.seo?.ogImage !== undefined) set['seo.ogImage'] = dto.seo.ogImage;
    if (dto.seo?.ogTitle !== undefined) set['seo.ogTitle'] = dto.seo.ogTitle;
    if (dto.seo?.ogDescription !== undefined) set['seo.ogDescription'] = dto.seo.ogDescription;
    if (dto.seo?.twitterCard !== undefined) set['seo.twitterCard'] = dto.seo.twitterCard;
    if (dto.seo?.canonicalUrlOverride !== undefined) set['seo.canonicalUrlOverride'] = dto.seo.canonicalUrlOverride;
    if (dto.seo?.noindex !== undefined) set['seo.noindex'] = dto.seo.noindex;
    if (dto.seo?.keywords !== undefined) set['seo.keywords'] = dto.seo.keywords;

    const updated = await this.storePageModel.findOneAndUpdate({ _id: pageId, storeId }, { $set: set }, { new: true });
    return { success: true, message: 'Page updated', data: updated };
  }

  /**
   * Writes to `draft.sections` only — this is the fix for the previously-real
   * bug where editing an already-published page changed what was live
   * immediately. A buyer never sees this until `publish()` is called.
   */
  async updateSections(storeId: string, sellerId: string, pageId: string, dto: UpdateSectionsDto, requestedThemeId?: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    this.contentVersioningService.assertDraftNotStale((page as any).updatedAt, dto.baseUpdatedAt);
    validateSections(dto.sections);
    const installedThemeId = await this.resolveInstalledThemeId(storeId, requestedThemeId);
    const templatePage = await this.ensurePageThemeTemplate(page, installedThemeId);
    if (installedThemeId) {
      const theme = await this.storeThemeModel.findOne({ _id: installedThemeId, storeId }).select('themeDefinitionId').lean();
      assertThemeSupportsSections(dto.sections, theme?.themeDefinitionId);
    } else {
      const activeTheme = await this.storeThemeModel.findOne({ storeId, status: 'active' }).select('themeDefinitionId').lean();
      assertThemeSupportsSections(dto.sections, activeTheme?.themeDefinitionId);
    }
    // Phase 8 — the second, DB-aware half of app-block validation (is the
    // app installed for THIS store, is the section type actually
    // supported, do settings match the app's own schema).
    await this.appsService.assertBlocksAllowed(storeId, dto.sections);
    // Phase 9 — Dynamic Sources: only a custom page is one real, singular
    // resource a metafield value can attach to; the Home page has no such
    // "current resource" (same reasoning Search/Cart/Blog-Index templates
    // already have on the CollectionTemplate side — see
    // CollectionTemplateService's own resolveOwnerResource).
    await this.metafieldsService.assertDynamicSourceBindingsValid(storeId, page.type === 'custom' ? 'page' : null, dto.sections);
    const updated = installedThemeId
      ? await this.storePageModel.findOneAndUpdate(
          { _id: pageId, storeId, 'themeTemplates.installedThemeId': installedThemeId },
          { $set: { 'themeTemplates.$.draftSections': dto.sections } },
          { new: true },
        )
      : await this.storePageModel.findOneAndUpdate(
          { _id: pageId, storeId },
          { $set: { 'draft.sections': dto.sections } },
          { new: true },
        );
    return { success: true, message: 'Draft saved', data: await this.presentPageForTheme(updated ?? templatePage, installedThemeId) };
  }

  /** Copies `draft.sections` to live and records its rollback snapshot in one atomic update. */
  async publish(storeId: string, sellerId: string, pageId: string, requestedThemeId?: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    const installedThemeId = await this.resolveInstalledThemeId(storeId, requestedThemeId);
    if (!installedThemeId) {
      const updated = await this.contentVersioningService.publishDraftWithVersion(
        this.storePageModel,
        { _id: pageId, storeId },
        { sections: '$draft.sections' },
        { status: 'published', lastPublishedAt: '$$NOW' },
        { sections: '$draft.sections', publishedAt: '$$NOW' },
      );
      if (!updated) throw new NotFoundException('Page could not be published because it no longer exists. Reload the page and try again.');
      return { success: true, message: 'Page published', data: updated };
    }

    await this.ensurePageThemeTemplate(page, installedThemeId);
    const theme = await this.storeThemeModel.findOne({ _id: installedThemeId, storeId }).select('status').lean();
    const versionId = new Types.ObjectId();
    const updated = await this.storePageModel.findOneAndUpdate(
      { _id: pageId, storeId, 'themeTemplates.installedThemeId': installedThemeId },
      [{ $set: {
        themeTemplates: { $map: {
          input: '$themeTemplates', as: 'template',
          in: { $cond: [
            { $eq: ['$$template.installedThemeId', installedThemeId] },
            { $mergeObjects: ['$$template', {
              sections: '$$template.draftSections',
              lastPublishedAt: '$$NOW',
              versions: { $slice: [
                { $concatArrays: [{ $ifNull: ['$$template.versions', []] }, [{
                  _id: versionId,
                  sections: '$$template.draftSections',
                  publishedAt: '$$NOW',
                }]] },
                -20,
              ] },
            }] },
            '$$template',
          ] },
        } },
        ...(theme?.status === 'active' ? { status: 'published' } : {}),
      } }],
      { new: true, updatePipeline: true },
    );
    if (!updated) throw new NotFoundException('Page template could not be published because it no longer exists. Reload the page and try again.');
    const refreshed = await this.storePageModel.findOne({ _id: pageId, storeId, isDelete: false });
    return { success: true, message: 'Theme page template published', data: await this.presentPageForTheme(refreshed, installedThemeId) };
  }

  async listVersions(storeId: string, sellerId: string, pageId: string, requestedThemeId?: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    const installedThemeId = await this.resolveInstalledThemeId(storeId, requestedThemeId);
    if (installedThemeId) {
      const themed = await this.ensurePageThemeTemplate(page, installedThemeId);
      const plain = typeof themed?.toObject === 'function' ? themed.toObject() : themed;
      const versions = (plain.themeTemplates?.find((entry: any) => String(entry.installedThemeId) === installedThemeId)?.versions ?? []).slice().reverse();
      return { success: true, data: versions };
    }
    const versions = await this.contentVersioningService.listVersions(this.storePageModel, { _id: pageId, storeId });
    return { success: true, data: versions };
  }

  /** Restores a past version into the DRAFT slot only — the seller still has to explicitly Publish afterward, same as every other draft edit. */
  async restoreVersion(storeId: string, sellerId: string, pageId: string, versionId: string, requestedThemeId?: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    const installedThemeId = await this.resolveInstalledThemeId(storeId, requestedThemeId);
    if (installedThemeId) {
      const themed = await this.ensurePageThemeTemplate(page, installedThemeId);
      const plain = typeof themed?.toObject === 'function' ? themed.toObject() : themed;
      const version = plain.themeTemplates?.find((entry: any) => String(entry.installedThemeId) === installedThemeId)?.versions?.find((entry: any) => String(entry._id) === versionId);
      if (!version) throw new BadRequestException('Version not found');
      const updated = await this.storePageModel.findOneAndUpdate(
        { _id: pageId, storeId, 'themeTemplates.installedThemeId': installedThemeId },
        { $set: { 'themeTemplates.$.draftSections': version.sections } },
        { new: true },
      );
      return { success: true, message: 'Version restored to draft — review and publish to make it live.', data: await this.presentPageForTheme(updated, installedThemeId) };
    }
    const version = await this.contentVersioningService.findVersion(this.storePageModel, { _id: pageId, storeId }, versionId);
    if (!version) throw new BadRequestException('Version not found');
    const updated = await this.contentVersioningService.restoreVersionToDraft(this.storePageModel, { _id: pageId, storeId }, {
      'draft.sections': version.sections,
    });
    return { success: true, message: 'Version restored to draft — review and publish to make it live.', data: updated };
  }

  /** Only flips visibility — doesn't touch `sections`/`draft.sections`, so re-publishing later doesn't need the seller to redo anything. */
  async unpublish(storeId: string, sellerId: string, pageId: string) {
    await this.findOwnedPage(storeId, sellerId, pageId);
    const updated = await this.storePageModel.findOneAndUpdate({ _id: pageId, storeId }, { $set: { status: 'draft' } }, { new: true });
    return { success: true, message: 'Page unpublished', data: updated };
  }

  /** Safety-net "discard unsaved changes" — copies the live `sections` back over `draft.sections`, the mirror image of `publish()`'s copy direction. Never touches `status`. */
  async revertDraft(storeId: string, sellerId: string, pageId: string, requestedThemeId?: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    const installedThemeId = await this.resolveInstalledThemeId(storeId, requestedThemeId);
    if (installedThemeId) {
      await this.ensurePageThemeTemplate(page, installedThemeId);
      const updated = await this.storePageModel.findOneAndUpdate(
        { _id: pageId, storeId, 'themeTemplates.installedThemeId': installedThemeId },
        [{ $set: { themeTemplates: { $map: {
          input: '$themeTemplates', as: 'template',
          in: { $cond: [
            { $eq: ['$$template.installedThemeId', installedThemeId] },
            { $mergeObjects: ['$$template', { draftSections: '$$template.sections' }] },
            '$$template',
          ] },
        } } } }],
        { new: true, updatePipeline: true },
      );
      return { success: true, message: 'Draft reverted to the published version', data: await this.presentPageForTheme(updated, installedThemeId) };
    }
    const updated = await this.contentVersioningService.revertDraft(this.storePageModel, { _id: pageId, storeId }, {
      'draft.sections': '$sections',
    });
    return { success: true, message: 'Draft reverted to the published version', data: updated };
  }

  async deletePage(storeId: string, sellerId: string, pageId: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    if (page.type === 'home') throw new ForbiddenException('The home page cannot be deleted');
    await this.storePageModel.findOneAndUpdate({ _id: pageId, storeId }, { $set: { isDelete: true } });
    return { success: true, message: 'Page deleted' };
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async getPublicHome(storeId: string) {
    const installedThemeId = await this.resolveInstalledThemeId(storeId);
    const page = await this.storePageModel.findOne({ storeId, type: 'home', status: 'published', isDelete: false });
    if (page) {
      const themed = await this.presentPageForTheme(page, installedThemeId);
      const { installedThemeId: _installedThemeId, ...publicPage } = themed as any;
      return { success: true, data: stripUnpublished(publicPage) };
    }
    // Defense-in-depth for stores created BEFORE the `ensureHomePage` fix
    // above (when new stores were seeded at status: 'draft'): rather than a
    // hard 404 that leaves the storefront blank forever, fall back to
    // whatever home-page content already exists — same graceful-fallback
    // shape `CollectionTemplateService` already uses for missing published
    // templates. This is a read-only display fallback; it does not silently
    // flip the stored doc to 'published' — the seller's own Publish action
    // in the Theme/Page editor remains the real, intentional publish step
    // for every page going forward.
    const anyHome = await this.storePageModel.findOne({ storeId, type: 'home', isDelete: false }).lean();
    // A home page without a published document must never render its draft to
    // anonymous visitors. Keep the public fallback on live content only; a
    // fresh starter layout is safer than exposing unpublished edits.
    const fallbackSections = anyHome?.sections?.length ? anyHome.sections : starterHomeSections();
    if (anyHome) {
      const themed = await this.presentPageForTheme({ ...anyHome, sections: fallbackSections }, installedThemeId);
      const { installedThemeId: _installedThemeId, ...publicPage } = themed as any;
      return { success: true, data: stripUnpublished(publicPage) };
    }
    throw new NotFoundException('This store has no home page yet');
  }

  async getPublicPage(storeId: string, slug: string) {
    const [page, installedThemeId] = await Promise.all([
      this.storePageModel.findOne({ storeId, slug, type: 'custom', status: 'published', isDelete: false }),
      this.resolveInstalledThemeId(storeId),
    ]);
    if (!page) throw new NotFoundException('Page not found');
    const themed = await this.presentPageForTheme(page, installedThemeId);
    const { installedThemeId: _installedThemeId, ...publicPage } = themed as any;
    return { success: true, data: stripUnpublished(publicPage) };
  }

  async listPublicPages(storeId: string) {
    const pages = await this.storePageModel
      .find({ storeId, type: 'custom', status: 'published', isDelete: false })
      .select('slug title showInNav showInFooter policyType')
      .lean();
    return { success: true, data: pages };
  }
}
