/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MetafieldDefinitionDocument = HydratedDocument<MetafieldDefinition>;

// Which resource a definition's values attach to — the same four resource
// types `CollectionTemplate`'s `RESOURCE_TEMPLATE_TYPES` already covers,
// plus 'collection' as its own real target (a Collection is a distinct
// Mongoose collection from a Category in this codebase).
export const METAFIELD_OWNER_RESOURCES = ['product', 'category', 'collection', 'page'] as const;
export type MetafieldOwnerResource = (typeof METAFIELD_OWNER_RESOURCES)[number];

// A deliberately-scoped subset of Shopify's ~113 metafield types (see
// shopify.dev's metafield data-type list) — the handful that cover the
// overwhelming majority of real custom-field use cases (a fabric/material
// note, a care-instructions paragraph, a spec number, a feature flag, a
// launch date, a swatch color, an external reference URL, or arbitrary
// structured data) without building out the full reference/list-of-N-types
// matrix in one pass. Every value is stored as a plain string regardless of
// `type` — same real Shopify convention (a metafield's value column is
// always a string; `type` is what tells a reader how to parse/validate it)
// — see `MetafieldValue.value` and `metafields.service.ts`'s `coerceValue`.
export const METAFIELD_TYPES = [
  'single_line_text_field',
  'multi_line_text_field',
  'number_integer',
  'number_decimal',
  'boolean',
  'date',
  'url',
  'color',
  'json',
] as const;
export type MetafieldType = (typeof METAFIELD_TYPES)[number];

/**
 * A merchant-defined custom field a store can attach to any product,
 * category, collection, or page — the real gap this closes: previously a
 * seller could not add so much as a "Fabric" or "Care Instructions" field to
 * a product without a backend schema migration. One definition can back
 * many `MetafieldValue` rows (one per resource it's actually set on) — see
 * that schema's own comment for why values live in their own collection
 * rather than embedded on Product/Category/Collection/StorePage directly.
 */
@Schema({ timestamps: true })
export class MetafieldDefinition {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ type: String, enum: METAFIELD_OWNER_RESOURCES, required: true, index: true })
  ownerResource: MetafieldOwnerResource;

  // Groups related fields the way Shopify's `custom.*` namespace does —
  // every seller-created definition lives under `custom` today (no UI to
  // choose a different namespace yet, so this is fixed rather than exposed,
  // matching this pass's deliberately-scoped custom-data surface).
  @Prop({ type: String, default: 'custom' })
  namespace: string;

  // Stable identifier a definition is referenced by — never shown to the
  // seller after creation (`name` is what they see/edit), immutable once
  // any `MetafieldValue` exists against it (enforced in the service).
  @Prop({ required: true })
  key: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: String, enum: METAFIELD_TYPES, required: true })
  type: MetafieldType;

  @Prop({ type: Boolean, default: false })
  required: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const MetafieldDefinitionSchema = SchemaFactory.createForClass(MetafieldDefinition);
MetafieldDefinitionSchema.index({ storeId: 1, ownerResource: 1, namespace: 1, key: 1 }, { unique: true });
