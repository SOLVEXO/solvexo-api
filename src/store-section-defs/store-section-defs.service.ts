import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { SavedSection, SavedSectionDocument } from '../saved-sections/saved-section.schema';
import { StoreSectionDef, StoreSectionDefDocument } from './store-section-def.schema';
import { deriveStoreSectionDef, sectionKeyFor } from './store-section-def.util';

/** A store keeps at most this many of its own section designs. */
export const MAX_STORE_SECTION_DEFS = 50;

export interface StoreSectionDefInput {
  name: string;
  description?: string;
  color?: string | null;
  layout: unknown;
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new BadRequestException('Give the section a name');
  if (name.length > 60) throw new BadRequestException('The name can be at most 60 characters');
  if (/[<>]/.test(name)) throw new BadRequestException('The name can not contain < or >');
  return name;
}

function cleanDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new BadRequestException('The description must be text');
  const d = raw.trim();
  if (d.length > 200) throw new BadRequestException('The description can be at most 200 characters');
  if (/[<>]/.test(d)) throw new BadRequestException('The description can not contain < or >');
  return d;
}

function cleanColor(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw)) throw new BadRequestException('The colour must look like #AABBCC');
  return raw;
}

@Injectable()
export class StoreSectionDefsService {
  constructor(
    @InjectModel(StoreSectionDef.name) private readonly model: Model<StoreSectionDefDocument>,
    @InjectModel(SavedSection.name) private readonly savedModel: Model<SavedSectionDocument>,
    private readonly databaseService: DatabaseService,
  ) {}

  async assertStoreAccess(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.databaseService.repositories.storeModel, storeId, sellerId);
  }

  private shape(doc: any) {
    return {
      _id: String(doc._id),
      key: doc.key,
      name: doc.name,
      description: doc.description ?? '',
      color: doc.color ?? null,
      layout: doc.layout,
      fields: doc.fields ?? [],
      block: doc.block ?? null,
      defaults: doc.defaults ?? {},
      initialBlocks: doc.initialBlocks ?? 0,
      updatedAt: doc.updatedAt ?? null,
    };
  }

  /** How many pages / templates / saved sections use each of the store's designs. */
  private async usageCounts(storeId: string): Promise<Map<string, number>> {
    const repos = this.databaseService.repositories;
    const filter: Record<string, any> = { storeId, $or: [{ 'sections.type': 'theme_section' }, { 'draft.sections.type': 'theme_section' }] };
    const [pages, templates, saved] = await Promise.all([
      repos.storePageModel.find(filter).select('sections draft.sections').lean(),
      repos.collectionTemplateModel.find(filter).select('sections draft.sections').lean(),
      this.savedModel.find({ storeId, type: 'theme_section' }).select('settings').lean(),
    ]);
    const counts = new Map<string, number>();
    const bump = (k: unknown, seen: Set<string>) => {
      const key = typeof k === 'string' ? k : '';
      if (key.startsWith('my.') && !seen.has(key)) { seen.add(key); counts.set(key, (counts.get(key) ?? 0) + 1); }
    };
    for (const doc of [...pages, ...templates] as any[]) {
      const seen = new Set<string>();
      for (const s of [...(doc.sections ?? []), ...(doc.draft?.sections ?? [])]) if (s?.type === 'theme_section') bump(s.settings?.sectionKey, seen);
    }
    for (const s of saved as any[]) bump(s.settings?.sectionKey, new Set<string>());
    return counts;
  }

  async list(storeId: string) {
    const [docs, usage] = await Promise.all([this.model.find({ storeId }).sort({ updatedAt: -1 }).lean(), this.usageCounts(storeId)]);
    return { success: true, data: docs.map((d) => ({ ...this.shape(d), usedOn: usage.get(d.key) ?? 0 })) };
  }

  /** Storefront read: what a `my.*` section is drawn from. Nothing private here (it is the layout visitors see). */
  async listPublic(storeId: string) {
    const docs = await this.model.find({ storeId }).lean();
    return { success: true, data: docs.map((d) => this.shape(d)) };
  }

  private async freeKey(storeId: string, name: string): Promise<string> {
    for (let n = 0; n < 50; n++) {
      const key = sectionKeyFor(name, n);
      if (!(await this.model.exists({ storeId, key }))) return key;
    }
    throw new ConflictException('Could not find a free key for this section, try another name');
  }

  async create(storeId: string, input: StoreSectionDefInput) {
    const name = cleanName(input.name);
    const derived = deriveStoreSectionDef(input.layout);
    if ((await this.model.countDocuments({ storeId })) >= MAX_STORE_SECTION_DEFS) {
      throw new BadRequestException(`You can build up to ${MAX_STORE_SECTION_DEFS} sections`);
    }
    try {
      const doc = await this.model.create({
        storeId, key: await this.freeKey(storeId, name), name, nameKey: name.toLowerCase(),
        description: cleanDescription(input.description), color: cleanColor(input.color),
        layout: derived.layout, fields: derived.fields, block: derived.block, defaults: derived.defaults, initialBlocks: derived.initialBlocks,
      });
      return { success: true, data: { ...this.shape(doc.toObject()), usedOn: 0 } };
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('A section with this name already exists');
      throw err;
    }
  }

  private async findOwned(storeId: string, id: string) {
    if (!isValidObjectId(id)) throw new NotFoundException('Section not found');
    const doc = await this.model.findOne({ _id: id, storeId });
    if (!doc) throw new NotFoundException('Section not found');
    return doc;
  }

  /** Rename and/or change the design. The key stays, so every page that uses the section keeps working; values of fields
   *  that no longer exist are simply not shown any more. */
  async update(storeId: string, id: string, input: Partial<StoreSectionDefInput>) {
    await this.findOwned(storeId, id);
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      patch.name = name;
      patch.nameKey = name.toLowerCase();
    }
    if (input.description !== undefined) patch.description = cleanDescription(input.description);
    if (input.color !== undefined) patch.color = cleanColor(input.color);
    if (input.layout !== undefined) {
      const d = deriveStoreSectionDef(input.layout);
      Object.assign(patch, { layout: d.layout, fields: d.fields, block: d.block, defaults: d.defaults, initialBlocks: d.initialBlocks });
    }
    try {
      const updated = await this.model.findOneAndUpdate({ _id: id, storeId }, { $set: patch }, { new: true }).lean();
      const usage = await this.usageCounts(storeId);
      return { success: true, data: { ...this.shape(updated), usedOn: usage.get((updated as any).key) ?? 0 } };
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('A section with this name already exists');
      throw err;
    }
  }

  async remove(storeId: string, id: string) {
    const doc = await this.findOwned(storeId, id);
    const used = (await this.usageCounts(storeId)).get(doc.key) ?? 0;
    if (used > 0) {
      throw new ConflictException(`This section is used on ${used} page${used === 1 ? '' : 's'}. Remove it from them before deleting it.`);
    }
    await this.model.deleteOne({ _id: id, storeId });
    return { success: true };
  }
}
