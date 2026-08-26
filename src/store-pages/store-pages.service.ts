/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateSectionSettings, validateBlocksOfType, SECTION_ALLOWED_BLOCK_TYPES } from '../common/store-content/section-settings.validator';
import { SectionType } from '../common/schemas/section.schema';
import { ContentVersioningService } from '../common/content-versioning/content-versioning.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { UpdateSectionsDto } from './dto/update-sections.dto';

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
const RESERVED_CUSTOM_PAGE_SLUGS = ['home', 'blog', 'category', 'collections', 'product', 'search', 'cart', 'checkout', 'login', 'register', 'verify-otp', 'account'];

function validateSections(sections: { type: SectionType; settings: Record<string, any>; blocks: { type: string; settings: Record<string, any> }[] }[]) {
  if (sections.length > MAX_SECTIONS_PER_PAGE) {
    throw new BadRequestException(`A page cannot have more than ${MAX_SECTIONS_PER_PAGE} sections`);
  }
  for (const section of sections) {
    validateSectionSettings(section.type, section.settings ?? {});
    validateBlocksOfType(section.blocks ?? [], SECTION_ALLOWED_BLOCK_TYPES[section.type]);
  }
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
  ) {}

  private get storePageModel() {
    return this.databaseService.repositories.storePageModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  /** Idempotent — called from `StoreService.createStore()` right after creation, and from the one-off backfill script for pre-existing stores. A brand-new home page starts as a usable draft with a hero + product catalog, not empty — its `draft.sections` starts identical to `sections`, since there's nothing yet to diverge. */
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
          status: 'draft',
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

  async listForSeller(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureHomePage(storeId);
    await this.backfillPageDrafts({ storeId });
    const pages = await this.storePageModel.find({ storeId, isDelete: false }).sort({ type: -1, createdAt: 1 }).lean();
    return { success: true, data: pages };
  }

  async getForSeller(storeId: string, sellerId: string, pageId: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    return { success: true, data: page };
  }

  /** The seller editor's actual working copy — `draft.sections` plus enough context (`lastPublishedAt`) to show a "you have unpublished changes" state. Mirrors `StoreThemeService#getDraft`'s shape/purpose. */
  async getDraft(storeId: string, sellerId: string, pageId: string) {
    const page = await this.findOwnedPage(storeId, sellerId, pageId);
    return {
      success: true,
      data: {
        sections: page.draft.sections,
        lastPublishedAt: page.lastPublishedAt,
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

    const set: Record<string, unknown> = {};
    if (dto.title !== undefined) set.title = dto.title;
    if (dto.slug !== undefined) set.slug = dto.slug;
    if (dto.showInNav !== undefined) set.showInNav = dto.showInNav;
    if (dto.showInFooter !== undefined) set.showInFooter = dto.showInFooter;
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
  async updateSections(storeId: string, sellerId: string, pageId: string, dto: UpdateSectionsDto) {
    await this.findOwnedPage(storeId, sellerId, pageId);
    validateSections(dto.sections);
    const updated = await this.storePageModel.findOneAndUpdate(
      { _id: pageId, storeId },
      { $set: { 'draft.sections': dto.sections } },
      { new: true },
    );
    return { success: true, message: 'Draft saved', data: updated };
  }

  /** Copies `draft.sections` → the live `sections` field in one atomic $set via the shared ContentVersioningService, marks the page published, and appends a real version snapshot of what just went live. Safe to call whether this is the page's first publish or the Nth — either way, whatever's in the draft right now is what goes live. */
  async publish(storeId: string, sellerId: string, pageId: string) {
    await this.findOwnedPage(storeId, sellerId, pageId);
    const updated = await this.contentVersioningService.publishDraft(
      this.storePageModel,
      { _id: pageId, storeId },
      { sections: '$draft.sections' },
      { status: 'published', lastPublishedAt: '$$NOW' },
    );
    const withVersion = await this.contentVersioningService.appendVersion(
      this.storePageModel,
      { _id: pageId, storeId },
      { sections: (updated as any)?.sections ?? [], publishedAt: (updated as any)?.lastPublishedAt ?? new Date() },
    );
    return { success: true, message: 'Page published', data: withVersion ?? updated };
  }

  async listVersions(storeId: string, sellerId: string, pageId: string) {
    await this.findOwnedPage(storeId, sellerId, pageId);
    const versions = await this.contentVersioningService.listVersions(this.storePageModel, { _id: pageId, storeId });
    return { success: true, data: versions };
  }

  /** Restores a past version into the DRAFT slot only — the seller still has to explicitly Publish afterward, same as every other draft edit. */
  async restoreVersion(storeId: string, sellerId: string, pageId: string, versionId: string) {
    await this.findOwnedPage(storeId, sellerId, pageId);
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
  async revertDraft(storeId: string, sellerId: string, pageId: string) {
    await this.findOwnedPage(storeId, sellerId, pageId);
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
    const page = await this.storePageModel.findOne({ storeId, type: 'home', status: 'published', isDelete: false }).lean();
    if (!page) throw new NotFoundException('This store has no published home page yet');
    return { success: true, data: page };
  }

  async getPublicPage(storeId: string, slug: string) {
    const page = await this.storePageModel.findOne({ storeId, slug, type: 'custom', status: 'published', isDelete: false }).lean();
    if (!page) throw new NotFoundException('Page not found');
    return { success: true, data: page };
  }

  async listPublicPages(storeId: string) {
    const pages = await this.storePageModel
      .find({ storeId, type: 'custom', status: 'published', isDelete: false })
      .select('slug title showInNav showInFooter')
      .lean();
    return { success: true, data: pages };
  }
}
