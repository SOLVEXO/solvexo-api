/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory,  } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type wishListDocument = wishList & Document;

@Schema({ timestamps: true })
export class wishList {

 @Prop({ type: String, required: true })
   userId: string;



  @Prop({ type: String, required: true })
   productId: string;

    @Prop({ type: String, required: true })
    productVariantId: string;



}

export const wishListSchema = SchemaFactory.createForClass(wishList);



wishListSchema.index({ productId: 1 });
wishListSchema.index({ productVariantId: 1 });
// Prevents duplicate wishlist entries from a double-tap race (two
// near-simultaneous add-to-wishlist requests both passing the
// findOne-based duplicate check in CartService.addToWishlist before
// either write commits).
wishListSchema.index({ userId: 1, productId: 1, productVariantId: 1 }, { unique: true });