import { Controller, Post, Put, Get, Body, Param, Req, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RatingService } from './rating.service';

@Controller('api/rating')
export class RatingController {
  constructor(private readonly ratingService: RatingService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('add-review')
  async addReview(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.ratingService.addReview(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('store-reviews/:storeId')
  async getStoreReviews(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const { userId: sellerId } = req.user;
    return this.ratingService.getStoreReviews(sellerId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Post('reply/:reviewId')
  async replyToReview(
    @Req() req: any,
    @Param('reviewId') reviewId: string,
    @Body() body: any,
  ) {
    const { userId: sellerId } = req.user;
    return this.ratingService.replyToReview(sellerId, reviewId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Put('edit-reply/:reviewId')
  async editReply(
    @Req() req: any,
    @Param('reviewId') reviewId: string,
    @Body() body: any,
  ) {
    const { userId: sellerId } = req.user;
    return this.ratingService.editReply(sellerId, reviewId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Post('flag/:reviewId')
  async flagReview(@Req() req: any, @Param('reviewId') reviewId: string) {
    const { userId: sellerId } = req.user;
    return this.ratingService.flagReview(sellerId, reviewId);
  }
}
