import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
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
}
