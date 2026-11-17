import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { SectionType } from '../common/schemas/section.schema';
import { sectionAcceptsAppBlocks } from '../common/store-content/app-block.util';
import {
  SECTION_ALLOWED_BLOCK_TYPES,
  collectDynamicSourceBindings,
  validateBlocksOfType,
  validateSectionSettings,
  MAX_BLOCKS_PER_SECTION,
} from '../common/store-content/section-settings.validator';
import { SavedSection, SavedSectionDocument } from './saved-section.schema';

/** A store keeps at most this many saved sections. */
export const MAX_SAVED_SECTIONS = 100;

/** Types that can not go into the library: the page's own fixed parts (core/customer-page markers) and a reference to another library entry. */
const NOT_SAVEABLE: readonly SectionType[] = [
  'saved_section', 'product_main', 'search_results', 'cart_items', 'cart_summary', 'blog_post_list', 'article_content', 'page_content',
];

export interface SavedSectionInput {
  name: string;
  type: SectionType;
  settings: Record<string, any>;
  blocks: { type: string; settings: Record<string, any>; enabled?: boolean; _id?: string }[];
  colorSchemeId?: string | null;
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new BadRequestException('Give the saved section a name');
  if (name.length > 60) throw new BadRequestException('The name can be at most 60 characters');
  return name;
}

/** Content rules shared by create and update: same checks as a section on a page, plus "no custom-field bindings" (a library entry has no product/page of its own to read them from). */
export function assertSavedSectionContent(type: SectionType, settings: Record<string, any>, blocks: SavedSectionInput['blocks']): void {
  if (NOT_SAVEABLE.includes(type)) throw new BadRequestException('This kind of section can not be saved to the library');
  if ((blocks?.length ?? 0) > MAX_BLOCKS_PER_SECTION) throw new BadRequestException(`A section can have at most ${MAX_BLOCKS_PER_SECTION} blocks`);
  validateSectionSettings(type, settings ?? {});
  validateBlocksOfType(blocks ?? [], SECTION_ALLOWED_BLOCK_TYPES[type], sectionAcceptsAppBlocks(type));
  if (collectDynamicSourceBindings([{ type, settings, blocks }]).length) {
    throw new BadRequestException('This section reads a custom field of one product or page, so it can not be shared. Remove that connection first.');
  }
}

@Injectable()
export class SavedSectionsService {
  constructor(
    @InjectModel(SavedSection.name) private readonly model: Model<SavedSectionDocument>,
    private readonly databaseService: DatabaseService,
  ) {}

  /** A seller must own the store; a staff caller was already pinned to its own store by PermissionsGuard, and acts for the owning seller. */
  async assertStoreAccess(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.databaseService.repositories.storeModel, storeId, sellerId);
  }

  private shape(doc: any) {
    return {
      _id: String(doc._id),
      name: doc.name,
      type: doc.type,
      settings: doc.settings ?? {},
      blocks: (doc.blocks ?? []).map((b: any) => ({ ...b, _id: b._id ? String(b._id) : undefined })),
      colorSchemeId: doc.colorSchemeId ?? null,
      updatedAt: doc.updatedAt ?? null,
    };
  }

  /** How many pages / templates (live or draft) use each entry: one pass over the documents that hold a reference at all. */
  private async usageCounts(storeId: string): Promise<Map<string, number>> {
    const repos = this.databaseService.repositories;
    const filter = { storeId, $or: [{ 'sections.type': 'saved_section' }, { 'draft.sections.type': 'saved_section' }] };
    const [pages, templates] = await Promise.all([
      repos.storePageModel.find(filter).select('sections draft.sections').lean(),
      repos.collectionTemplateModel.find(filter).select('sections draft.sections').lean(),
    ]);
    const counts = new Map<string, number>();
    for (const doc of [...pages, ...templates] as any[]) {
      const ids = new Set<string>();
      for (const s of [...(doc.sections ?? []), ...(doc.draft?.sections ?? [])]) {
        if (s?.type === 'saved_section' && s.settings?.savedSectionId) ids.add(String(s.settings.savedSectionId));
      }
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  /** Seller list, with "used on N pages". */
  async list(storeId: string) {
    const [docs, usage] = await Promise.all([this.model.find({ storeId }).sort({ updatedAt: -1 }).lean(), this.usageCounts(storeId)]);
    return { success: true, data: docs.map((d) => ({ ...this.shape(d), usedOn: usage.get(String(d._id)) ?? 0 })) };
  }

  /** Storefront read: the content a `saved_section` reference is drawn from. Nothing here is private (it is what visitors see). */
  async listPublic(storeId: string) {
    const docs = await this.model.find({ storeId }).lean();
    return { success: true, data: docs.map((d) => this.shape(d)) };
  }

  async create(storeId: string, input: SavedSectionInput) {
    const name = cleanName(input.name);
    assertSavedSectionContent(input.type, input.settings, input.blocks);
    if ((await this.model.countDocuments({ storeId })) >= MAX_SAVED_SECTIONS) {
      throw new BadRequestException(`You can keep up to ${MAX_SAVED_SECTIONS} saved sections`);
    }
    try {
      const doc = await this.model.create({
        storeId, name, nameKey: name.toLowerCase(), type: input.type,
        settings: input.settings ?? {}, blocks: input.blocks ?? [], colorSchemeId: input.colorSchemeId ?? null,
      });
      return { success: true, data: { ...this.shape(doc.toObject()), usedOn: 0 } };
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('A saved section with this name already exists');
      throw err;
    }
  }

  private async findOwned(storeId: string, id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Saved section not found');
    const doc = await this.model.findOne({ _id: id, storeId });
    if (!doc) throw new NotFoundException('Saved section not found');
    return doc;
  }

  /** Rename and/or replace the content. The type is fixed: pages that use the entry keep drawing the same kind of section. */
  async update(storeId: string, id: string, input: Partial<SavedSectionInput>) {
    const doc = await this.findOwned(storeId, id);
    if (input.type && input.type !== doc.type) throw new BadRequestException('The kind of a saved section can not change');
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      patch.name = name;
      patch.nameKey = name.toLowerCase();
    }
    if (input.settings !== undefined || input.blocks !== undefined) {
      const settings = input.settings ?? doc.settings ?? {};
      const blocks = input.blocks ?? (doc.blocks as any[]);
      assertSavedSectionContent(doc.type, settings, blocks);
      patch.settings = settings;
      patch.blocks = blocks;
    }
    if (input.colorSchemeId !== undefined) patch.colorSchemeId = input.colorSchemeId;
    try {
      const updated = await this.model.findOneAndUpdate({ _id: id, storeId }, { $set: patch }, { new: true }).lean();
      const usage = await this.usageCounts(storeId);
      return { success: true, data: { ...this.shape(updated), usedOn: usage.get(String(id)) ?? 0 } };
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('A saved section with this name already exists');
      throw err;
    }
  }

  /** A section that pages still use can not be deleted (they would lose it): detach or remove it there first. */
  async remove(storeId: string, id: string) {
    await this.findOwned(storeId, id);
    const used = (await this.usageCounts(storeId)).get(String(id)) ?? 0;
    if (used > 0) {
      throw new ConflictException(`This saved section is used on ${used} page${used === 1 ? '' : 's'}. Remove it from them, or detach it there, before deleting it.`);
    }
    await this.model.deleteOne({ _id: id, storeId });
    return { success: true };
  }
}
