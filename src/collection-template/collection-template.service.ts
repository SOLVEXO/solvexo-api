/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateSectionSettings, validateBlocksOfType, SECTION_ALLOWED_BLOCK_TYPES } from '../common/store-content/section-settings.validator';
import { SectionType } from '../common/schemas/section.schema';
import { ContentVersioningService } from '../common/content-versioning/content-versioning.service';
import { UpdateSectionsDto } from '../store-pages/dto/update-sections.dto';
import { ResourceTemplateType } from './schemas/collection-template.schema';
import { CreateResourceTemplateDto } from './dto/create-resource-template.dto';

const MAX_SECTIONS_PER_TEMPLATE = 40;
const DEFAULT_TEMPLATE_KEY = 'default';

function starterSections(resourceType: ResourceTemplateType) {
  // The one section a template of each resource type can't meaningfully
  // ship without — a seller can add more sections above/below it, reorder,
  // or hide it, but it's always pre-seeded so a fresh store's browse/detail
  // pages never render blank. Product's "core" commerce block (gallery/
  // variant/add-to-cart) is fixed chrome outside this section system
  // entirely (see StorefrontProductPage) — a product template's sections are
  // purely the SURROUNDING content (recommendations, rich text, etc.), so it
  // starts empty rather than pre-seeded with a placeholder. Same for 'page'
  // templates (Blog Index, Search, and any other non-collection page bucket)
  // — these already have their own real, non-section-driven listing content
  // (blog posts, search results), so pre-seeding a commerce product grid on
  // top of that would render a second, unrelated product grid on the page.
  if (resourceType === 'product' || resourceType === 'page') return [];
  return [{ type: 'collection_product_grid' as SectionType, settings: { columns: 3, showFilters: true }, blocks: [] }];
}

function validateSections(sections: { type: SectionType; settings: Record<string, any>; blocks: { type: string; settings: Record<string, any> }[] }[]) {
  if (sections.length > MAX_SECTIONS_PER_TEMPLATE) {
    throw new BadRequestException(`A template cannot have more than ${MAX_SECTIONS_PER_TEMPLATE} sections`);
  }
  for (const section of sections) {
    validateSectionSettings(section.type, section.settings ?? {});
    validateBlocksOfType(section.blocks ?? [], SECTION_ALLOWED_BLOCK_TYPES[section.type]);
  }
}

@Injectable()
export class CollectionTemplateService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly contentVersioningService: ContentVersioningService,
  ) {}

  private get collectionTemplateModel() {
    return this.databaseService.repositories.collectionTemplateModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  /** Idempotent getOrCreate for one (resourceType, templateKey) pair — same shape as `StorePagesService#ensureHomePage`. A brand-new template starts as a usable draft with its starter content already in it, not empty (except Product's, see `starterSections`). Every pre-existing caller omits both params and gets exactly today's single collection-layout document back. */
  async ensureTemplate(storeId: string, resourceType: ResourceTemplateType = 'collection', templateKey = DEFAULT_TEMPLATE_KEY) {
    const seed = starterSections(resourceType);
    return this.collectionTemplateModel.findOneAndUpdate(
      { storeId, resourceType, templateKey },
      {
        $setOnInsert: {
          storeId,
          resourceType,
          templateKey,
          name: templateKey === DEFAULT_TEMPLATE_KEY ? 'Default' : templateKey,
          isDefault: templateKey === DEFAULT_TEMPLATE_KEY,
          sections: seed,
          draft: { sections: seed },
          status: 'draft',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  /** See `ContentVersioningService#backfillDraft` — a template saved before the draft/publish split gets `draft.sections` seeded from its live `sections` the first time it's touched. */
  private async backfillDraft(filter: Record<string, unknown>) {
    await this.contentVersioningService.backfillDraft(this.collectionTemplateModel, filter, 'draft', {
      sections: '$sections',
    });
  }

  private async findOwnedTemplate(storeId: string, sellerId: string, resourceType: ResourceTemplateType, templateKey: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureTemplate(storeId, resourceType, templateKey);
    const filter = { storeId, resourceType, templateKey };
    await this.backfillDraft(filter);
    const template = await this.collectionTemplateModel.findOne(filter);
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  // ── Template management (Theme Library "alternate templates") ──────────

  async listTemplates(storeId: string, sellerId: string, resourceType: ResourceTemplateType) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureTemplate(storeId, resourceType, DEFAULT_TEMPLATE_KEY);
    const templates = await this.collectionTemplateModel.find({ storeId, resourceType }).sort({ isDefault: -1, name: 1 }).lean();
    return { success: true, data: templates };
  }

  async createTemplate(storeId: string, sellerId: string, resourceType: ResourceTemplateType, dto: CreateResourceTemplateDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const templateKey = dto.templateKey.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!templateKey) throw new BadRequestException('templateKey is required');
    const existing = await this.collectionTemplateModel.findOne({ storeId, resourceType, templateKey });
    if (existing) throw new BadRequestException(`A ${resourceType} template with key "${templateKey}" already exists`);

    const seed = dto.cloneFromTemplateKey
      ? (await this.collectionTemplateModel.findOne({ storeId, resourceType, templateKey: dto.cloneFromTemplateKey }))?.sections ?? starterSections(resourceType)
      : starterSections(resourceType);

    const created = await this.collectionTemplateModel.create({
      storeId,
      resourceType,
      templateKey,
      name: dto.name,
      isDefault: false,
      sections: seed,
      draft: { sections: seed },
      status: 'draft',
    });
    return { success: true, message: 'Template created', data: created };
  }

  async deleteTemplate(storeId: string, sellerId: string, resourceType: ResourceTemplateType, templateKey: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    if (templateKey === DEFAULT_TEMPLATE_KEY) throw new ForbiddenException('Cannot remove the default template');
    const deleted = await this.collectionTemplateModel.findOneAndDelete({ storeId, resourceType, templateKey });
    if (!deleted) throw new NotFoundException('Template not found');
    return { success: true, message: 'Template removed' };
  }

  // ── Seller — resolved (resourceType, templateKey) surface, backward-
  // compatible defaults so the pre-existing Collection Template caller
  // (which never passes either) is completely unaffected. ────────────────

  async getForSeller(storeId: string, sellerId: string, resourceType: ResourceTemplateType = 'collection', templateKey = DEFAULT_TEMPLATE_KEY) {
    const template = await this.findOwnedTemplate(storeId, sellerId, resourceType, templateKey);
    return { success: true, data: template };
  }

  /** The builder's actual working copy — mirrors `StorePagesService#getDraft`'s shape/purpose. */
  async getDraft(storeId: string, sellerId: string, resourceType: ResourceTemplateType = 'collection', templateKey = DEFAULT_TEMPLATE_KEY) {
    const template = await this.findOwnedTemplate(storeId, sellerId, resourceType, templateKey);
    return {
      success: true,
      data: {
        sections: template.draft.sections,
        lastPublishedAt: template.lastPublishedAt,
      },
    };
  }

  /** Writes to `draft.sections` only — a buyer never sees this until `publish()` is called. */
  async updateSections(storeId: string, sellerId: string, dto: UpdateSectionsDto, resourceType: ResourceTemplateType = 'collection', templateKey = DEFAULT_TEMPLATE_KEY) {
    const template = await this.findOwnedTemplate(storeId, sellerId, resourceType, templateKey);
    validateSections(dto.sections);
    const updated = await this.collectionTemplateModel.findOneAndUpdate(
      { _id: template._id },
      { $set: { 'draft.sections': dto.sections } },
      { new: true },
    );
    return { success: true, message: 'Draft saved', data: updated };
  }

  /** Copies `draft.sections` → the live `sections` field atomically via the shared ContentVersioningService, and appends a real version snapshot of what just went live. */
  async publish(storeId: string, sellerId: string, resourceType: ResourceTemplateType = 'collection', templateKey = DEFAULT_TEMPLATE_KEY) {
    const template = await this.findOwnedTemplate(storeId, sellerId, resourceType, templateKey);
    const filter = { _id: template._id };
    const updated = await this.contentVersioningService.publishDraft(
      this.collectionTemplateModel,
      filter,
      { sections: '$draft.sections' },
      { status: 'published', lastPublishedAt: '$$NOW' },
    );
    const withVersion = await this.contentVersioningService.appendVersion(
      this.collectionTemplateModel,
      filter,
      { sections: (updated as any)?.sections ?? [], publishedAt: (updated as any)?.lastPublishedAt ?? new Date() },
    );
    return { success: true, message: 'Template published', data: withVersion ?? updated };
  }

  async listVersions(storeId: string, sellerId: string, resourceType: ResourceTemplateType = 'collection', templateKey = DEFAULT_TEMPLATE_KEY) {
    const template = await this.findOwnedTemplate(storeId, sellerId, resourceType, templateKey);
    const versions = await this.contentVersioningService.listVersions(this.collectionTemplateModel, { _id: template._id });
    return { success: true, data: versions };
  }

  async restoreVersion(storeId: string, sellerId: string, versionId: string, resourceType: ResourceTemplateType = 'collection', templateKey = DEFAULT_TEMPLATE_KEY) {
    const template = await this.findOwnedTemplate(storeId, sellerId, resourceType, templateKey);
    const filter = { _id: template._id };
    const version = await this.contentVersioningService.findVersion(this.collectionTemplateModel, filter, versionId);
    if (!version) throw new BadRequestException('Version not found');
    const updated = await this.contentVersioningService.restoreVersionToDraft(this.collectionTemplateModel, filter, {
      'draft.sections': version.sections,
    });
    return { success: true, message: 'Version restored to draft — review and publish to make it live.', data: updated };
  }

  /** Safety-net "discard unsaved changes" — mirror image of `publish()`'s copy direction. */
  async revertDraft(storeId: string, sellerId: string, resourceType: ResourceTemplateType = 'collection', templateKey = DEFAULT_TEMPLATE_KEY) {
    const template = await this.findOwnedTemplate(storeId, sellerId, resourceType, templateKey);
    const updated = await this.contentVersioningService.revertDraft(this.collectionTemplateModel, { _id: template._id }, {
      'draft.sections': '$sections',
    });
    return { success: true, message: 'Draft reverted to the published version', data: updated };
  }

  // ── Public ───────────────────────────────────────────────────────────────

  /** Falls back to a fresh (unsaved) starter template when a store hasn't been touched via `ensureTemplate` yet, rather than 404ing a store's very first browse/detail visit. */
  /** Unauthenticated — must never leak `draft` (unpublished edits) or
   *  `versions` (full publish history) to a public visitor, same reasoning
   *  as `StoreThemeService.getPublic`. */
  async getPublic(storeId: string, resourceType: ResourceTemplateType = 'collection', templateKey = DEFAULT_TEMPLATE_KEY) {
    const template = await this.collectionTemplateModel
      .findOne({ storeId, resourceType, templateKey, status: 'published' }, { draft: 0, versions: 0 })
      .lean();
    if (template) return { success: true, data: template };
    return { success: true, data: { sections: starterSections(resourceType) } };
  }
}
