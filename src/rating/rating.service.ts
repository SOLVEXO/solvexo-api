import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';

import { DatabaseService } from 'src/database/databaseservice';


@Injectable()
export class RatingService {
  constructor(
    private databaseService: DatabaseService,
  ) {}

  async addReview(userId: string, body: any) {
  try {
    const { productId, productVariantId, rating, comment } = body;

    // 1. validate rating
    if (rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    // 2. check product exists
    const product =
      await this.databaseService.repositories.productModel.findById(productId);

    if (!product) {
      throw new BadRequestException('Product not found');
    }

    // 3. prevent duplicate review (one user per product)
    const existingReview =
      await this.databaseService.repositories.ratingModel.findOne({
        userId,
        productId,
        isDelete: false,
      });

    if (existingReview) {
      throw new BadRequestException('You already reviewed this product');
    }

    // 4. create review
    const review =
      await this.databaseService.repositories.ratingModel.create({
        userId,
        productId,
        productVariantId,
        rating
      });

    // 5. calculate total ratings (count)
    const totalRatings =
      await this.databaseService.repositories.ratingModel.countDocuments({
        productId,
        isDelete: false,
      });

    // 6. calculate rating sum (aggregate)
    const result =
      await this.databaseService.repositories.ratingModel.aggregate([
        {
          $match: {
            productId,
            isDelete: false,
          },
        },
        {
          $group: {
            _id: null,
            totalSum: { $sum: "$rating" },
          },
        },
      ]);

    const ratingSum = result.length > 0 ? result[0].totalSum : 0;

    // 7. calculate average
    const averageRating = totalRatings
      ? ratingSum / totalRatings
      : 0;

    // 8. update product
    await this.databaseService.repositories.productModel.findByIdAndUpdate(
      productId,
      {
          ratingSum,
        averageRating,
      },
    );

    return {
      message: 'Review added successfully',
      data: review,
    };

  } catch (error: any) {
    throw new BadRequestException(
      error.message || 'Failed to add review',
    );
  }
}
}