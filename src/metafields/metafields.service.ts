/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreateDefinitionDto } from './dto/create-definition.dto';
import { UpdateDefinitionDto } from './dto/update-definition.dto';
import { SetValuesDto } from './dto/set-values.dto';
import { MetafieldOwnerResource, MetafieldType } from './schemas/metafield-definition.schema';

/** Real per-type validation for a metafield's string value — same
 *  "everything is a string, `type` says how to read it" model the schema
 *  comment describes. Empty string is always allowed (means "cleared"). */
function assertValueMatchesType(type: MetafieldType, value: string, fieldPath: string): void {
  if (value === '') return;
  switch (type) {
    case 'number_integer':
      if (!/^-?\d+$/.test(value)) throw new BadRequestException(`${fieldPath} must be a whole number`);
      break;
    case 'number_decimal':
      if (Number.isNaN(Number(value))) throw new BadRequestException(`${fieldPath} must be a number`);
      break;
    case 'boolean':
      if (value !== 'true' && value !== 'false') throw new BadRequestException(`${fieldPath} must be "true" or "false"`);
      break;
    case 'date':
      if (Number.isNaN(Date.parse(value))) throw new BadRequestException(`${fieldPath} must be a valid date`);
      break;
    case 'url':
      try { const u = new URL(value); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(); }
      catch { throw new BadRequestException(`${fieldPath} must be a valid URL`); }
      break;
    case 'color':
      if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value)) throw new BadRequestException(`${fieldPath} must be a hex color, e.g. #FF5500`);
      break;
    case 'json':
      try { JSON.parse(value); } catch { throw new BadRequestException(`${fieldPath} must be valid JSON`); }
      break;
    case 'single_line_text_field':
      if (value.length > 255) throw new BadRequestException(`${fieldPath} cannot exceed 255 characters`);
      break;
    case 'multi_line_text_field':
      if (value.length > 5000) throw new BadRequestException(`${fieldPath} cannot exceed 5,000 characters`);
      break;
  }
}

@Injectable()
export class MetafieldsService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get definitionModel() { return this.databaseService.repositories.metafieldDefinitionModel; }
  private get valueModel() { return this.databaseService.repositories.metafieldValueModel; }
  private get storeModel() { return this.databaseService.repositories.storeModel; }

  // ── Definitions (admin-managed schema — what fields exist) ──────────────

  async listDefinitions(storeId: string, sellerId: string, ownerResource?: MetafieldOwnerResource) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const filter: Record<string, unknown> = { storeId };
    if (ownerResource) filter.ownerResource = ownerResource;
    const definitions = await this.definitionModel.find(filter).sort({ createdAt: 1 }).lean();
    return { success: true, data: definitions };
  }

  async createDefinition(storeId: string, sellerId: string, dto: CreateDefinitionDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const existing = await this.definitionModel.findOne({ storeId, ownerResource: dto.ownerResource, namespace: 'custom', key: dto.key });
    if (existing) throw new ConflictException(`A "${dto.key}" field already exists for ${dto.ownerResource}s`);
    const created = await this.definitionModel.create({ ...dto, storeId, namespace: 'custom' });
    return { success: true, message: 'Metafield definition created', data: created };
  }

  async updateDefinition(storeId: string, sellerId: string, definitionId: string, dto: UpdateDefinitionDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const updated = await this.definitionModel.findOneAndUpdate({ _id: definitionId, storeId }, { $set: dto }, { new: true });
    if (!updated) throw new NotFoundException('Metafield definition not found');
    return { success: true, message: 'Metafield definition updated', data: updated };
  }

  async deleteDefinition(storeId: string, sellerId: string, definitionId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const definition = await this.definitionModel.findOne({ _id: definitionId, storeId });
    if (!definition) throw new NotFoundException('Metafield definition not found');
    // Cascade — an orphaned value nobody can ever see or edit again is worse
    // than removing it outright; the resource it was on simply loses that
    // field, exactly as if it had never been set.
    await this.valueModel.deleteMany({ storeId, ownerResource: definition.ownerResource, namespace: definition.namespace, key: definition.key });
    await definition.deleteOne();
    return { success: true, message: 'Metafield definition deleted' };
  }

  // ── Values (per-resource data) ───────────────────────────────────────────

  /** Every value for one resource, each annotated with its definition's `type`/`name` so a consumer never needs a second round trip to render an editor or interpret the raw string. */
  async getValues(storeId: string, sellerId: string, ownerResource: MetafieldOwnerResource, ownerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    return this.resolveValues(storeId, ownerResource, ownerId);
  }

  /** Same shape as `getValues`, no auth — for the public storefront (a future "show this metafield on the product page" consumer; not yet wired into any theme section, a disclosed follow-up). */
  async getPublicValues(storeId: string, ownerResource: MetafieldOwnerResource, ownerId: string) {
    return this.resolveValues(storeId, ownerResource, ownerId);
  }

  private async resolveValues(storeId: string, ownerResource: MetafieldOwnerResource, ownerId: string) {
    const [definitions, values] = await Promise.all([
      this.definitionModel.find({ storeId, ownerResource }).lean(),
      this.valueModel.find({ storeId, ownerResource, ownerId }).lean(),
    ]);
    const valueByKey = new Map(values.map(v => [`${v.namespace}:${v.key}`, v.value]));
    const data = definitions.map(def => ({
      definitionId: def._id,
      namespace: def.namespace,
      key: def.key,
      name: def.name,
      type: def.type,
      required: def.required,
      value: valueByKey.get(`${def.namespace}:${def.key}`) ?? '',
    }));
    return { success: true, data };
  }

  /** Full upsert — every definition for this `ownerResource` gets a row (blank string if the caller didn't send one), matching how the seller-facing edit form always renders one input per definition. Rejects a `{namespace,key}` that doesn't match a real definition rather than silently creating an untyped, unvalidated value. */
  async setValues(storeId: string, sellerId: string, ownerResource: MetafieldOwnerResource, ownerId: string, dto: SetValuesDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const definitions = await this.definitionModel.find({ storeId, ownerResource }).lean();
    const defByKey = new Map(definitions.map(d => [`${d.namespace}:${d.key}`, d]));

    for (const v of dto.values) {
      const def = defByKey.get(`${v.namespace}:${v.key}`);
      if (!def) throw new BadRequestException(`No "${v.key}" field is defined for ${ownerResource}s`);
      if (def.required && v.value === '') throw new BadRequestException(`"${def.name}" is required`);
      assertValueMatchesType(def.type, v.value, def.name);
    }

    await Promise.all(dto.values.map(v => {
      if (v.value === '') {
        return this.valueModel.deleteOne({ storeId, ownerResource, ownerId, namespace: v.namespace, key: v.key });
      }
      return this.valueModel.findOneAndUpdate(
        { storeId, ownerResource, ownerId, namespace: v.namespace, key: v.key },
        { $set: { value: v.value } },
        { upsert: true },
      );
    }));

    return this.resolveValues(storeId, ownerResource, ownerId);
  }
}
