/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { assertValueMatchesType } from '../metafields/metafields.service';
import { CreateMetaobjectDefinitionDto } from './dto/create-metaobject-definition.dto';
import { UpdateMetaobjectDefinitionDto } from './dto/update-metaobject-definition.dto';
import { SetEntryFieldsDto } from './dto/set-entry-fields.dto';

@Injectable()
export class MetaobjectsService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get definitionModel() { return this.databaseService.repositories.metaobjectDefinitionModel; }
  private get entryModel() { return this.databaseService.repositories.metaobjectEntryModel; }
  private get storeModel() { return this.databaseService.repositories.storeModel; }

  // ── Definitions (the seller-invented content TYPE) ──────────────────────

  async listDefinitions(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const definitions = await this.definitionModel.find({ storeId }).sort({ createdAt: 1 }).lean();
    // Real entry counts, not guessed — the seller's own list needs to show
    // "12 entries" per type without a second round trip per row.
    const counts = await this.entryModel.aggregate([
      { $match: { storeId } },
      { $group: { _id: '$definitionId', count: { $sum: 1 } } },
    ]);
    const countByDefinitionId = new Map(counts.map(c => [String(c._id), c.count]));
    const data = definitions.map(d => ({ ...d, entryCount: countByDefinitionId.get(String(d._id)) ?? 0 }));
    return { success: true, data };
  }

  async getDefinition(storeId: string, sellerId: string, definitionId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const definition = await this.definitionModel.findOne({ _id: definitionId, storeId }).lean();
    if (!definition) throw new NotFoundException('Metaobject definition not found');
    return { success: true, data: definition };
  }

  async createDefinition(storeId: string, sellerId: string, dto: CreateMetaobjectDefinitionDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const existing = await this.definitionModel.findOne({ storeId, type: dto.type });
    if (existing) throw new ConflictException(`A "${dto.type}" metaobject type already exists`);
    this.assertUniqueFieldKeys(dto.fieldDefinitions);
    const created = await this.definitionModel.create({ ...dto, storeId });
    return { success: true, message: 'Metaobject type created', data: created };
  }

  async updateDefinition(storeId: string, sellerId: string, definitionId: string, dto: UpdateMetaobjectDefinitionDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const definition = await this.definitionModel.findOne({ _id: definitionId, storeId });
    if (!definition) throw new NotFoundException('Metaobject definition not found');

    if (dto.fieldDefinitions) {
      this.assertUniqueFieldKeys(dto.fieldDefinitions);
      // Removing/retyping a field that real entries already store a value
      // under would leave those entries holding orphaned or wrongly-typed
      // data — same "immutable once referenced" protection
      // `UpdateDefinitionDto`'s own comment describes for Metafields, real
      // instead of assumed here (checked against actual entry documents,
      // not just "any entry of this type exists").
      const entryCount = await this.entryModel.countDocuments({ storeId, definitionId });
      if (entryCount > 0) {
        const nextByKey = new Map(dto.fieldDefinitions.map(f => [f.key, f]));
        for (const existingField of definition.fieldDefinitions) {
          const next = nextByKey.get(existingField.key);
          if (!next) throw new BadRequestException(`Cannot remove field "${existingField.name}" — ${entryCount} existing ${entryCount === 1 ? 'entry' : 'entries'} still use it. Delete those entries first.`);
          if (next.type !== existingField.type) throw new BadRequestException(`Cannot change the type of field "${existingField.name}" — ${entryCount} existing ${entryCount === 1 ? 'entry' : 'entries'} already store a value for it.`);
        }
      }
    }

    const updated = await this.definitionModel.findOneAndUpdate({ _id: definitionId, storeId }, { $set: dto }, { new: true });
    return { success: true, message: 'Metaobject type updated', data: updated };
  }

  async deleteDefinition(storeId: string, sellerId: string, definitionId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const definition = await this.definitionModel.findOne({ _id: definitionId, storeId });
    if (!definition) throw new NotFoundException('Metaobject definition not found');
    // Cascade — same "an orphaned row nobody can ever see or edit again is
    // worse than removing it outright" reasoning as Metafields' own
    // `deleteDefinition`.
    await this.entryModel.deleteMany({ storeId, definitionId });
    await definition.deleteOne();
    return { success: true, message: 'Metaobject type deleted' };
  }

  private assertUniqueFieldKeys(fields: { key: string }[]): void {
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.key)) throw new BadRequestException(`Field key "${f.key}" is used more than once`);
      seen.add(f.key);
    }
  }

  // ── Entries (real instances of a type) ───────────────────────────────────

  async listEntries(storeId: string, sellerId: string, definitionId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const entries = await this.entryModel.find({ storeId, definitionId }).sort({ createdAt: -1 }).lean();
    return { success: true, data: entries };
  }

  async getEntry(storeId: string, sellerId: string, entryId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const entry = await this.entryModel.findOne({ _id: entryId, storeId }).lean();
    if (!entry) throw new NotFoundException('Entry not found');
    return { success: true, data: entry };
  }

  async createEntry(storeId: string, sellerId: string, definitionId: string, dto: SetEntryFieldsDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const definition = await this.definitionModel.findOne({ _id: definitionId, storeId }).lean();
    if (!definition) throw new NotFoundException('Metaobject definition not found');
    const fields = this.validateAndNormalizeFields(definition.fieldDefinitions, dto.fields);
    const created = await this.entryModel.create({
      storeId, definitionId, type: definition.type, displayName: dto.displayName, fields,
    });
    return { success: true, message: 'Entry created', data: created };
  }

  async updateEntry(storeId: string, sellerId: string, entryId: string, dto: SetEntryFieldsDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const entry = await this.entryModel.findOne({ _id: entryId, storeId });
    if (!entry) throw new NotFoundException('Entry not found');
    const definition = await this.definitionModel.findOne({ _id: entry.definitionId, storeId }).lean();
    if (!definition) throw new NotFoundException('Metaobject definition not found');
    const fields = this.validateAndNormalizeFields(definition.fieldDefinitions, dto.fields);
    const updated = await this.entryModel.findOneAndUpdate(
      { _id: entryId, storeId },
      { $set: { displayName: dto.displayName, fields } },
      { new: true },
    );
    return { success: true, message: 'Entry updated', data: updated };
  }

  async deleteEntry(storeId: string, sellerId: string, entryId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const result = await this.entryModel.deleteOne({ _id: entryId, storeId });
    if (result.deletedCount === 0) throw new NotFoundException('Entry not found');
    return { success: true, message: 'Entry deleted' };
  }

  private validateAndNormalizeFields(
    fieldDefinitions: { key: string; name: string; type: any; required: boolean }[],
    submitted: { key: string; value: string }[],
  ) {
    const valueByKey = new Map(submitted.map(f => [f.key, f.value]));
    // Full upsert, one row per real field definition — same "always one
    // input per definition, blank if unset" convention `MetafieldsService.
    // resolveValues` already established, so a seller's edit form never has
    // to guess which fields exist.
    return fieldDefinitions.map(def => {
      const value = valueByKey.get(def.key) ?? '';
      if (def.required && value === '') throw new BadRequestException(`"${def.name}" is required`);
      assertValueMatchesType(def.type, value, def.name);
      return { key: def.key, value };
    });
  }

  // ── Public (storefront) reads ────────────────────────────────────────────

  /** Every entry of one type — the real consumer of "Dynamic Sources"-style
   *  metaobject lists on the storefront (e.g. a Team Grid section listing
   *  every "team_member" entry). No auth; a store's metaobject content is
   *  public storefront data, same visibility level as its products. */
  async getPublicEntriesByType(storeId: string, type: string) {
    const entries = await this.entryModel.find({ storeId, type }).sort({ createdAt: -1 }).lean();
    return { success: true, data: entries };
  }

  async getPublicEntry(storeId: string, entryId: string) {
    const entry = await this.entryModel.findOne({ _id: entryId, storeId }).lean();
    if (!entry) throw new NotFoundException('Entry not found');
    return { success: true, data: entry };
  }

  /** The store's own list of defined types (id/type/name only, no field
   *  schema) — feeds the storefront section editor's "which metaobject type
   *  should this list show?" picker, the same way `apiListCollections`
   *  feeds a collection picker. */
  async getPublicDefinitions(storeId: string) {
    const definitions = await this.definitionModel.find({ storeId }).select('type name').sort({ createdAt: 1 }).lean();
    return { success: true, data: definitions };
  }
}
