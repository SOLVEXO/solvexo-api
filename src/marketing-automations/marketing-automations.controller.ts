/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsMongoId } from 'class-validator';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '@/auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PermissionsGuard } from '@/auth/guards/permissions.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RequirePermission } from '@/auth/decorators/require-permission.decorator';
import { actingSellerId } from '@/common/acting-seller-id.util';
import { MarketingAutomationsService } from './marketing-automations.service';

class BackInStockDto {
  @IsMongoId() storeId: string;
  @IsMongoId() productId: string;
  @IsMongoId() variantId: string;
  @IsEmail() email: string;
}

@ApiTags('Marketing automations')
@Controller('api/marketing-automations')
export class MarketingAutomationsController {
  constructor(private readonly automations: MarketingAutomationsService) {}

  // ── Seller ────────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Get(':storeId/settings')
  async getSettings(@Req() req: any, @Param('storeId') storeId: string) {
    await this.automations.assertStoreOwner(storeId, actingSellerId(req.user));
    return this.automations.getSettingsForSeller(storeId);
  }

  /** Partial update — any of { welcome, backInStock, priceDrop, winBack },
   *  each with any of its own fields. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Put(':storeId/settings')
  async updateSettings(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    await this.automations.assertStoreOwner(storeId, actingSellerId(req.user));
    return this.automations.updateSettings(storeId, body);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Get(':storeId/stats')
  async stats(@Req() req: any, @Param('storeId') storeId: string) {
    await this.automations.assertStoreOwner(storeId, actingSellerId(req.user));
    return this.automations.getStats(storeId);
  }

  /** "[Test]" copy of one automation's email, with sample data. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Post(':storeId/test/:section')
  async sendTest(@Req() req: any, @Param('storeId') storeId: string, @Param('section') section: string, @Body() body: { email?: string }) {
    await this.automations.assertStoreOwner(storeId, actingSellerId(req.user));
    const email = typeof body?.email === 'string' && body.email.trim() ? body.email.trim() : req.user?.email ?? null;
    return this.automations.sendTest(storeId, section, email);
  }

  // ── Public (storefront) ───────────────────────────────────────────────

  @Get('public/:storeId')
  publicConfig(@Param('storeId') storeId: string) {
    return this.automations.publicConfig(storeId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(OptionalJwtAuthGuard)
  @Post('back-in-stock')
  backInStock(@Req() req: any, @Body() dto: BackInStockDto) {
    const userId = req.user?.role === 'user' ? req.user.userId : null;
    return this.automations.requestBackInStock({ ...dto, userId });
  }
}
