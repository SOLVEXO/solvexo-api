/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { MetafieldOwnerResource, METAFIELD_OWNER_RESOURCES } from './metafield-definition.schema';

export type MetafieldValueDocument = HydratedDocument<MetafieldValue>;

/**
 * One resource's value for one `MetafieldDefinition` — deliberately its own
 * collection rather than an embedded array on Product/Category/Collection/
 * StorePage. Embedding would mean editing four existing, already-large
 * schema files just to add a custom-data feature; a separate collection
 * keyed by `{storeId, ownerResource, ownerId, namespace, key}` needs zero
 * changes to any of them — `getValues(ownerResource, ownerId)` is a single
 * indexed query, same shape as how `MediaAsset.checkUsage` already looks up
 * cross-collection references in this codebase.
 */
@Schema({ timestamps: true })
export class MetafieldValue {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ type: String, enum: METAFIELD_OWNER_RESOURCES, required: true })
  ownerResource: MetafieldOwnerResource;

  // The Product/Category/Collection/StorePage `_id` this value belongs to.
  @Prop({ required: true })
  ownerId: string;

  @Prop({ type: String, default: 'custom' })
  namespace: string;

  @Prop({ required: true })
  key: string;

  // Always a string on the wire and at rest — `type` (read off the matching
  // `MetafieldDefinition`) is what tells a reader how to parse/validate it.
  // Same real Shopify convention; avoids a Mongoose mixed-type field whose
  // shape would otherwise have to vary per `type`.
  @Prop({ type: String, required: true })
  value: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const MetafieldValueSchema = SchemaFactory.createForClass(MetafieldValue);
// The real read pattern every consumer uses ("every value for this one
// resource") is already served by this index's own leading prefix
// ({storeId, ownerResource, ownerId}) — no separate index needed for it.
MetafieldValueSchema.index({ storeId: 1, ownerResource: 1, ownerId: 1, namespace: 1, key: 1 }, { unique: true });
