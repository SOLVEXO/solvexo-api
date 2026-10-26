/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Post, Put, Request, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PlatformTaxService } from './platform-tax.service';
import { ApplyPlatformTaxDto, UpdatePlatformTaxDto } from './dto/update-platform-tax.dto';

@ApiTags('Admin Platform Tax')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/platform-tax')
export class PlatformTaxController {
  constructor(private readonly service: PlatformTaxService) {}

  @RequirePermission('billing.manage')
  @Get()
  async get() {
    return { success: true, data: await this.service.getSettings() };
  }

  /** Paying countries that currently have no usable rate (draft / not listed / not started), with how many stores. */
  @RequirePermission('billing.manage')
  @Get('coverage')
  async coverage() {
    return { success: true, data: await this.service.coverageGaps() };
  }

  @RequirePermission('billing.manage')
  @Put()
  async update(@Body() dto: UpdatePlatformTaxDto, @Request() req: any) {
    return { success: true, data: await this.service.update(dto, req.user.userId) };
  }

  /** dryRun:true only counts; otherwise sets/clears the tax rate on every live Stripe plan subscription. */
  @RequirePermission('billing.manage')
  @Post('apply-to-subscriptions')
  async apply(@Body() dto: ApplyPlatformTaxDto, @Request() req: any) {
    return { success: true, data: await this.service.applyToExistingSubscriptions(dto.dryRun !== false, req.user.userId) };
  }
}
