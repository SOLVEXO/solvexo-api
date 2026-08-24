/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateSectionSettings, validateBlocksOfType, SECTION_ALLOWED_BLOCK_TYPES } from '../common/store-content/section-settings.validator';
import { SectionType } from '../common/schemas/section.schema';
import { ContentVersioningService } from '../common/content-versioning/content-versioning.service';
import { UpdateSectionsDto } from '../store-pages/dto/update-sections.dto';

const MAX_SECTIONS_PER_TEMPLATE = 40;

function starterCollectionSections() {
  // The one section a Collection template can't meaningfully ship without —
  // a seller can add more sections above/below it, reorder, or hide it, but
  // it's always pre-seeded so a fresh store's `/collections/:slug` pages
  // never render blank.
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

  /** Idempotent getOrCreate — same shape as `StorePagesService#ensureHomePage`. A brand-new template starts as a usable draft with the product grid already in it, not empty. */
  async ensureTemplate(storeId: string) {
    return this.collectionTemplateModel.findOneAndUpdate(
      { storeId },
      {
        $setOnInsert: {
          storeId,
          sections: starterCollectionSections(),
          draft: { sections: starterCollectionSections() },
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

  private async findOwnedTemplate(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureTemplate(storeId);
    await this.backfillDraft({ storeId });
    const template = await this.collectionTemplateModel.findOne({ storeId });
    if (!template) throw new NotFoundException('Collection template not found');
    return template;
  }

  // ── Seller ───────────────────────────────────────────────────────────────

  async getForSeller(storeId: string, sellerId: string) {
    const template = await this.findOwnedTemplate(storeId, sellerId);
    return { success: true, data: template };
  }

  /** The builder's actual working copy — mirrors `StorePagesService#getDraft`'s shape/purpose. */
  async getDraft(storeId: string, sellerId: string) {
    const template = await this.findOwnedTemplate(storeId, sellerId);
    return {
      success: true,
      data: {
        sections: template.draft.sections,
        lastPublishedAt: template.lastPublishedAt,
      },
    };
  }

  /** Writes to `draft.sections` only — a buyer never sees this until `publish()` is called. */
  async updateSections(storeId: string, sellerId: string, dto: UpdateSectionsDto) {
    await this.findOwnedTemplate(storeId, sellerId);
    validateSections(dto.sections);
    const updated = await this.collectionTemplateModel.findOneAndUpdate(
      { storeId },
      { $set: { 'draft.sections': dto.sections } },
      { new: true },
    );
    return { success: true, message: 'Draft saved', data: updated };
  }

  /** Copies `draft.sections` → the live `sections` field atomically via the shared ContentVersioningService, and appends a real version snapshot of what just went live. */
  async publish(storeId: string, sellerId: string) {
    await this.findOwnedTemplate(storeId, sellerId);
    const updated = await this.contentVersioningService.publishDraft(
      this.collectionTemplateModel,
      { storeId },
      { sections: '$draft.sections' },
      { status: 'published', lastPublishedAt: '$$NOW' },
    );
    const withVersion = await this.contentVersioningService.appendVersion(
      this.collectionTemplateModel,
      { storeId },
      { sections: (updated as any)?.sections ?? [], publishedAt: (updated as any)?.lastPublishedAt ?? new Date() },
    );
    return { success: true, message: 'Collection template published', data: withVersion ?? updated };
  }

  async listVersions(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const versions = await this.contentVersioningService.listVersions(this.collectionTemplateModel, { storeId });
    return { success: true, data: versions };
  }

  async restoreVersion(storeId: string, sellerId: string, versionId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const version = await this.contentVersioningService.findVersion(this.collectionTemplateModel, { storeId }, versionId);
    if (!version) throw new BadRequestException('Version not found');
    const updated = await this.contentVersioningService.restoreVersionToDraft(this.collectionTemplateModel, { storeId }, {
      'draft.sections': version.sections,
    });
    return { success: true, message: 'Version restored to draft — review and publish to make it live.', data: updated };
  }

  /** Safety-net "discard unsaved changes" — mirror image of `publish()`'s copy direction. */
  async revertDraft(storeId: string, sellerId: string) {
    await this.findOwnedTemplate(storeId, sellerId);
    const updated = await this.contentVersioningService.revertDraft(this.collectionTemplateModel, { storeId }, {
      'draft.sections': '$sections',
    });
    return { success: true, message: 'Draft reverted to the published version', data: updated };
  }

  // ── Public ───────────────────────────────────────────────────────────────

  /** Falls back to a fresh (unsaved) starter template when a store hasn't been touched via `ensureTemplate` yet, rather than 404ing a store's very first collection-page visit. */
  async getPublic(storeId: string) {
    const template = await this.collectionTemplateModel.findOne({ storeId, status: 'published' }).lean();
    if (template) return { success: true, data: template };
    return { success: true, data: { sections: starterCollectionSections() } };
  }
}
