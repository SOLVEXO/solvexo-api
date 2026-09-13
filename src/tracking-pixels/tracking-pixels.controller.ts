/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { TrackingPixelsService } from './tracking-pixels.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UpdateTrackingPixelSettingsDto } from './dto/update-tracking-pixel-settings.dto';

@ApiTags('Tracking Pixels')
@Controller('api/tracking-pixels')
export class TrackingPixelsController {
  constructor(private readonly trackingPixelsService: TrackingPixelsService) {}

  // ── Public — the storefront reads this on every page load ───────────────
  @Get(':storeId/public')
  getPublicSettings(@Param('storeId') storeId: string) {
    return this.trackingPixelsService.getPublicSettings(storeId);
  }

  // ── Seller-facing ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId')
  getSettings(@Req() req: any, @Param('storeId') storeId: string) {
    return this.trackingPixelsService.getSettings(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId')
  updateSettings(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateTrackingPixelSettingsDto) {
    return this.trackingPixelsService.updateSettings(req.user.userId, storeId, dto);
  }
}
