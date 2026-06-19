import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

@Injectable()
export class RatingService {
  constructor(private databaseService: DatabaseService) {}

  async addReview(userId: string, body: any) {
    const { productId, productVariantId, orderId, rating, comment, isAnonymous, media } = body;

    if (!productId) throw new BadRequestException('productId is required');

    const { productModel, ratingModel } = this.databaseService.repositories;

    const product = await productModel.findOne({ _id: productId, isDelete: false });
    if (!product) throw new BadRequestException('Product not found');

    const existing = await ratingModel.findOne({ userId, productId, isDelete: false });

    if (existing) {
      if (rating !== undefined || media !== undefined || isAnonymous !== undefined) {
        throw new BadRequestException('Rating, media and isAnonymous can only be set once');
      }
      if (!comment) throw new BadRequestException('Only comment can be added to an existing review');

      await ratingModel.findByIdAndUpdate(existing._id, {
        $push: { comments: { text: comment, createdAt: new Date() } },
      });

      return { success: true, message: 'Comment added', data: await ratingModel.findById(existing._id).lean() };
    }

    if (rating !== undefined && (rating < 1 || rating > 5)) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    const reviewData: any = {
      userId,
      productId,
      storeId: product.storeId || null,
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

  async getStoreReviews(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { storeModel, ratingModel, userModel } = this.databaseService.repositories;

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const page = parseInt(query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false };
    if (query.rating && query.rating !== 'all') filter.rating = parseInt(query.rating);
    if (query.productId && query.productId !== 'all') filter.productId = query.productId;

    const totalReviews = await ratingModel.countDocuments(filter);
    const totalPages = Math.ceil(totalReviews / limit);

    const reviews = await ratingModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();

    // stats
    const allReviews = await ratingModel.find({ storeId, isDelete: false }).lean();

    const ratingBreakdown: Record<string, number> = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
    let ratingSum = 0;
    let ratingCount = 0;
    let flaggedCount = 0;
    let repliedCount = 0;
    let totalResponseMs = 0;
    let responseTimeCount = 0;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let reviewsThisMonth = 0;

    for (const r of allReviews) {
      if (r.rating) {
        ratingBreakdown[String(r.rating)] = (ratingBreakdown[String(r.rating)] || 0) + 1;
        ratingSum += r.rating;
        ratingCount++;
      }
      if (r.isFlagged) flaggedCount++;
      if (r.sellerReply) {
        repliedCount++;
        const replyCreatedAt = new Date(r.sellerReply.createdAt).getTime();
        const reviewCreatedAt = new Date(r.createdAt).getTime();
        const replyTime = replyCreatedAt - reviewCreatedAt;
        if (!isNaN(replyTime) && replyTime >= 0) {
          totalResponseMs += replyTime;
          responseTimeCount++;
        }
      }
      if (new Date(r.createdAt) >= monthStart) reviewsThisMonth++;
    }

    const averageRating = ratingCount > 0 ? parseFloat((ratingSum / ratingCount).toFixed(1)) : 0;
    const fiveStarRate = ratingCount > 0 ? parseFloat(((ratingBreakdown['5'] / ratingCount) * 100).toFixed(1)) : 0;
    const responseRate = allReviews.length > 0 ? parseFloat(((repliedCount / allReviews.length) * 100).toFixed(1)) : 0;
    const avgResponseHrs = responseTimeCount > 0 ? parseFloat((totalResponseMs / responseTimeCount / 3600000).toFixed(1)) : 0;

    // breakdown percentages
    const breakdownPercent: Record<string, string> = {};
    for (const star of ['5', '4', '3', '2', '1']) {
      breakdownPercent[star] = ratingCount > 0
        ? `${parseFloat(((ratingBreakdown[star] / ratingCount) * 100).toFixed(1))}%`
        : '0%';
    }

    // format list
    const list = await Promise.all(
      reviews.map(async (r: any) => {
        const user = await userModel.findById(r.userId).select('name email').lean();
        return {
          reviewId: r._id,
          customer: {
            name: r.isAnonymous ? 'Anonymous' : (user as any)?.name || 'Unknown',
            email: r.isAnonymous ? null : (user as any)?.email || null,
          },
          productId: r.productId,
          productVariantId: r.productVariantId || null,
          rating: r.rating,
          comments: r.comments,
          media: r.media,
          sellerReply: r.sellerReply || null,
          isFlagged: r.isFlagged,
          createdAt: r.createdAt,
        };
      }),
    );

    return {
      success: true,
      data: {
        stats: {
          averageRating,
          totalReviews: allReviews.length,
          ratingBreakdown: breakdownPercent,
          reviewsThisMonth,
          flaggedReviews: flaggedCount,
          fiveStarRate: `${fiveStarRate}%`,
          responseRate: `${responseRate}%`,
          avgResponseTime: `${avgResponseHrs} hrs`,
        },
        pagination: { page, limit, totalPages, total: totalReviews },
        reviews: list,
      },
    };
  }

  async replyToReview(sellerId: string, reviewId: string, body: any) {
    const { text } = body;
    if (!text) throw new BadRequestException('Reply text is required');

    const { ratingModel, storeModel } = this.databaseService.repositories;

    const review = await ratingModel.findOne({ _id: reviewId, isDelete: false });
    if (!review) throw new NotFoundException('Review not found');

    const store = await storeModel.findOne({ _id: review.storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Unauthorized');

    if (review.sellerReply) throw new BadRequestException('Already replied. Use edit-reply to update.');

    await ratingModel.findByIdAndUpdate(reviewId, {
      sellerReply: { text, createdAt: new Date(), updatedAt: new Date() },
    });

    return { success: true, message: 'Reply added' };
  }

  async editReply(sellerId: string, reviewId: string, body: any) {
    const { text } = body;
    if (!text) throw new BadRequestException('Reply text is required');

    const { ratingModel, storeModel } = this.databaseService.repositories;

    const review = await ratingModel.findOne({ _id: reviewId, isDelete: false });
    if (!review) throw new NotFoundException('Review not found');

    const store = await storeModel.findOne({ _id: review.storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Unauthorized');

    if (!review.sellerReply) throw new BadRequestException('No reply exists. Use reply first.');

    await ratingModel.findByIdAndUpdate(reviewId, {
      'sellerReply.text': text,
      'sellerReply.updatedAt': new Date(),
    });

    return { success: true, message: 'Reply updated' };
  }

  async flagReview(sellerId: string, reviewId: string) {
    const { ratingModel, storeModel } = this.databaseService.repositories;

    const review = await ratingModel.findOne({ _id: reviewId, isDelete: false });
    if (!review) throw new NotFoundException('Review not found');

    const store = await storeModel.findOne({ _id: review.storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Unauthorized');

    if (review.isFlagged) throw new BadRequestException('Review is already flagged');

    await ratingModel.findByIdAndUpdate(reviewId, { isFlagged: true });

    return { success: true, message: 'Review flagged' };
  }
}
