import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FaqDocument = HydratedDocument<Faq>;

@Schema({ timestamps: true })
export class Faq {
    _id: string;

    @Prop({ required: true, trim: true })
    question: string;

    @Prop({ required: true })
    answer: string;

    @Prop({ default: 'general', lowercase: true, trim: true })
    category: string;

    @Prop({ default: 0, min: 0 })
    order: number;

    @Prop({ default: true })
    isActive: boolean;

    createdAt?: Date;
    updatedAt?: Date;
}

export const FaqSchema = SchemaFactory.createForClass(Faq);

// ─── Indexes ─────────────────────────────────
FaqSchema.index({ category: 1 });
FaqSchema.index({ isActive: 1 });
FaqSchema.index({ order: 1 });
FaqSchema.index({ question: 'text', answer: 'text' }); // for search

// ─── Remove __v from JSON ────────────────────
FaqSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.__v;
    return obj;
};