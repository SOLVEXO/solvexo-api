/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Put, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminConfigService } from './admin-config.service';
import { UpdateFeatureFlagsDto } from './dto/update-feature-flags.dto';
import { UpdateAiConfigDto } from './dto/update-ai-config.dto';
import { UpdateEmailConfigDto } from './dto/update-email-config.dto';
import { UpdateMaintenanceDto } from './dto/update-maintenance.dto';
import { UpdatePlacementLimitsDto } from './dto/update-placement-limits.dto';
import { UpdatePromotionPricingDto } from './dto/update-promotion-pricing.dto';
import { UpdatePayoutConfigDto } from './dto/update-payout-config.dto';
import { UpdateManualPaymentConfigDto } from './dto/update-manual-payment-config.dto';
import { UpdateFxConfigDto } from './dto/update-fx-config.dto';
import { AddCurrencyDto, UpdateCurrencyBandDto } from './dto/currency-band.dto';

@ApiTags('Admin Platform Config')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/platform-config')
export class AdminConfigController {
  constructor(private readonly adminConfigService: AdminConfigService) {}

  @Get()
  getConfig() {
    return this.adminConfigService.getConfig();
  }

  @Put('feature-flags')
  updateFeatureFlags(@Req() req: any, @Body() dto: UpdateFeatureFlagsDto) {
    return this.adminConfigService.updateFeatureFlags(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Put('ai')
  updateAiConfig(@Req() req: any, @Body() dto: UpdateAiConfigDto) {
    return this.adminConfigService.updateAiConfig(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Put('email')
  updateEmailConfig(@Req() req: any, @Body() dto: UpdateEmailConfigDto) {
    return this.adminConfigService.updateEmailConfig(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Put('placement-limits')
  updatePlacementLimits(@Req() req: any, @Body() dto: UpdatePlacementLimitsDto) {
    return this.adminConfigService.updatePlacementLimits(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Put('payout')
  updatePayoutConfig(@Req() req: any, @Body() dto: UpdatePayoutConfigDto) {
    return this.adminConfigService.updatePayoutConfig(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Put('promotion-pricing')
  updatePromotionPricing(@Req() req: any, @Body() dto: UpdatePromotionPricingDto) {
    return this.adminConfigService.updatePromotionPricing(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Put('manual-payment')
  updateManualPaymentConfig(@Req() req: any, @Body() dto: UpdateManualPaymentConfigDto) {
    return this.adminConfigService.updateManualPaymentConfig(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Put('fx')
  updateFxConfig(@Req() req: any, @Body() dto: UpdateFxConfigDto) {
    return this.adminConfigService.updateFxConfig(dto, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // ── Dynamic, admin-managed currency list (Markets) — see AdminConfigService's
  // own doc comments on getEnabledCurrencies/addCurrency/updateCurrencyBand/
  // removeCurrency for why this replaced the old fixed 8-entry array. ──
  @Get('currencies')
  listCurrencies() {
    return this.adminConfigService.getEnabledCurrencies();
  }

  @Post('currencies')
  addCurrency(@Req() req: any, @Body() dto: AddCurrencyDto) {
    return this.adminConfigService.addCurrency(dto.code, dto.sanityBandMin, dto.sanityBandMax, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Patch('currencies/:code')
  updateCurrencyBand(@Req() req: any, @Param('code') code: string, @Body() dto: UpdateCurrencyBandDto) {
    return this.adminConfigService.updateCurrencyBand(code, dto.sanityBandMin, dto.sanityBandMax, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Delete('currencies/:code')
  removeCurrency(@Req() req: any, @Param('code') code: string) {
    return this.adminConfigService.removeCurrency(code, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Patch('maintenance')
  setMaintenanceMode(@Req() req: any, @Body() dto: UpdateMaintenanceDto) {
    return this.adminConfigService.setMaintenanceMode(dto.maintenanceMode, {
      adminId: req.user.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
