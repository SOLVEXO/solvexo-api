/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MetaobjectEntryDocument = HydratedDocument<MetaobjectEntry>;

/** One field's real value on one entry — always a string at rest, same
 *  "type lives on the definition, not the value" convention as
 *  `MetafieldValue.value`. */
@Schema({ _id: false })
export class MetaobjectFieldValue {
  @Prop({ required: true }) key: string;
  @Prop({ type: String, default: '' }) value: string;
}
export const MetaobjectFieldValueSchema = SchemaFactory.createForClass(MetaobjectFieldValue);

/**
 * One real instance of a `MetaobjectDefinition` (e.g. one actual team
 * member, one actual size-guide row). Its own collection, keyed by
 * `{storeId, definitionId}` — same "separate collection, not embedded"
 * rationale as `MetafieldValue` (a definition's field list can change
 * without ever touching entry documents).
 */
@Schema({ timestamps: true })
export class MetaobjectEntry {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true, index: true })
  definitionId: string;

  // Denormalized from the definition at creation time — lets a storefront
  // section list "every entry of type X" with one indexed query instead of
  // a definitionId lookup first. Definitions never rename `type` after
  // entries exist (see that schema's own comment), so this can't drift.
  @Prop({ required: true, index: true })
  type: string;

  // Shown in the seller's own entry list (e.g. "Jane Doe") — NOT a field
  // value itself; the seller picks which real field's value backs this at
  // entry-save time (the service copies it in), same as how a blog post's
  // own `title` is separate from its body content blocks.
  @Prop({ required: true })
  displayName: string;

  @Prop({ type: [MetaobjectFieldValueSchema], default: [] })
  fields: MetaobjectFieldValue[];

  createdAt?: Date;
  updatedAt?: Date;
}

export const MetaobjectEntrySchema = SchemaFactory.createForClass(MetaobjectEntry);
MetaobjectEntrySchema.index({ storeId: 1, type: 1, createdAt: -1 });
