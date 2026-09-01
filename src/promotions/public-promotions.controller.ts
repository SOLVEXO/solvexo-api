/* eslint-disable prettier/prettier */
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { PromotionsService } from './promotions.service';
import { TrackPromotionEventDto } from './dto/track-promotion-event.dto';

// Public (no required auth) — impression/click beacons fire from every buyer's
// page view, logged-in or not. Rate-limited by the app-wide default ThrottlerGuard.
@ApiTags('Promotions (public)')
@UseGuards(OptionalJwtAuthGuard)
@Controller('api/promotions')
export class PublicPromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Post('track/impression')
  trackImpression(@Body() dto: TrackPromotionEventDto) {
    return this.promotionsService.trackImpression(dto.entityType, dto.entityId, dto.device, dto.storeId);
  }

  @Post('track/click')
  trackClick(@Req() req: any, @Body() dto: TrackPromotionEventDto) {
    return this.promotionsService.trackClick(dto.entityType, dto.entityId, dto.device, dto.country, dto.city, req.user?.userId ?? null, dto.storeId);
  }
}
