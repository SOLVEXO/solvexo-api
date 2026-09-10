/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { METAFIELD_TYPES, MetafieldType } from '../../metafields/schemas/metafield-definition.schema';

export type MetaobjectDefinitionDocument = HydratedDocument<MetaobjectDefinition>;

/** One field a Metaobject's entries all share — same real Shopify convention
 *  as `MetafieldDefinition.type`: a value is always stored as a string, this
 *  is what tells a reader how to parse/validate it. Reuses the same
 *  `METAFIELD_TYPES` catalog (single_line_text_field/multi_line_text_field/
 *  number_integer/number_decimal/boolean/date/url/color/json) rather than a
 *  second parallel type system. */
@Schema({ _id: false })
export class MetaobjectFieldDefinition {
  @Prop({ required: true }) key: string;
  @Prop({ required: true }) name: string;
  @Prop({ type: String, enum: METAFIELD_TYPES, required: true }) type: MetafieldType;
  @Prop({ type: Boolean, default: false }) required: boolean;
}
export const MetaobjectFieldDefinitionSchema = SchemaFactory.createForClass(MetaobjectFieldDefinition);

/**
 * A merchant-defined structured content TYPE — the real gap this closes
 * beyond Metafields: a metafield attaches ad-hoc extra fields to an
 * EXISTING resource (a product, a category); a Metaobject is a genuinely
 * NEW kind of resource the seller invents themselves (e.g. "Team Member" —
 * name + photo + role, or "Size Guide" — a reusable structured entry with
 * no product/category of its own), matching real Shopify Metaobjects.
 *
 * One definition (a `type` slug + an ordered list of field definitions)
 * backs many `MetaobjectEntry` documents — same one-schema-many-instances
 * relationship `MetafieldDefinition`/`MetafieldValue` already have, and for
 * the same reason: editing this definition (add/rename/remove a field) never
 * needs a Mongoose schema migration.
 */
@Schema({ timestamps: true })
export class MetaobjectDefinition {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  // Stable machine identifier (e.g. "team_member") — referenced by every
  // `MetaobjectEntry` of this type and by any storefront section that lists
  // entries of this type. Immutable once any entry exists (enforced in the
  // service), same "key never changes after real data references it"
  // convention as `MetafieldDefinition.key`.
  @Prop({ required: true })
  type: string;

  // What the seller sees (e.g. "Team Member") — freely editable, `type`
  // (above) is the stable reference, this is just display text.
  @Prop({ required: true })
  name: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: [MetaobjectFieldDefinitionSchema], default: [] })
  fieldDefinitions: MetaobjectFieldDefinition[];

  createdAt?: Date;
  updatedAt?: Date;
}

export const MetaobjectDefinitionSchema = SchemaFactory.createForClass(MetaobjectDefinition);
MetaobjectDefinitionSchema.index({ storeId: 1, type: 1 }, { unique: true });
