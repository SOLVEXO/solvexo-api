import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BannerDocument = HydratedDocument<Banner>;

@Schema({ timestamps: true })
export class Banner {
    _id: string;

    @Prop({ required: true })
    imageUrl: string;

    @Prop({ default: '' })
    publicId: string;

    @Prop({ default: true })
    isActive: boolean;

    @Prop({ default: 0 })
    order: number; // display order

    createdAt?: Date;
    updatedAt?: Date;
}

export const BannerSchema = SchemaFactory.createForClass(Banner);

BannerSchema.index({ isActive: 1 });
BannerSchema.index({ order: 1 });

BannerSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.__v;
    return obj;
};