import { Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

@Injectable()
export class RatingService {
  constructor(private databaseService: DatabaseService) {}

  async addReview(userId: string, body: any) {
    const { productId, productVariantId, orderId, rating, comment, isAnonymous, media } = body;

    if (!productId) throw new BadRequestException('productId is required');

    const { productModel, ratingModel } = this.databaseService.repositories;

    // 1. product check
    const product = await productModel.findOne({ _id: productId, isDelete: false });
    if (!product) throw new BadRequestException('Product not found');

    // 2. existing review check
    const existing = await ratingModel.findOne({ userId, productId, isDelete: false });

    if (existing) {
      // already reviewed — sirf comment allow hai
      if (rating !== undefined || media !== undefined || isAnonymous !== undefined) {
        throw new BadRequestException('Rating, media and isAnonymous can only be set once');
      }

      if (!comment) throw new BadRequestException('Only comment can be added to an existing review');

      await ratingModel.findByIdAndUpdate(existing._id, {
        $push: { comments: { text: comment, createdAt: new Date() } },
      });

      return { success: true, message: 'Comment added', data: await ratingModel.findById(existing._id).lean() };
    }

    // 3. pehli baar — rating agar di hai toh validate
    if (rating !== undefined && (rating < 1 || rating > 5)) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    // 4. review create
    const reviewData: any = {
      userId,
      productId,
      productVariantId: productVariantId || null,
      orderId: orderId || null,
      rating: rating ?? null,
      media: media || [],
      isAnonymous: isAnonymous ?? false,
      comments: [],
    };

    if (comment) {
      reviewData.comments.push({ text: comment, createdAt: new Date() });
    }

    const review = await ratingModel.create(reviewData);

    // 5. product averageRating update (sirf agar rating di)
    if (rating) {
      const newRatingSum = (product.ratingSum || 0) + rating;
      const totalRatings = await ratingModel.countDocuments({ productId, isDelete: false, rating: { $ne: null } });
      const averageRating = newRatingSum / totalRatings;

      await productModel.findByIdAndUpdate(productId, {
        ratingSum: newRatingSum,
        averageRating: parseFloat(averageRating.toFixed(2)),
      });
    }

    return { success: true, message: 'Review added', data: review };
  }
}
