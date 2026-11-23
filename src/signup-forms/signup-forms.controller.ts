/* eslint-disable prettier/prettier */
import { AuditStoreWrites } from '@/activity-log/audit-store-writes';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { SignupFormsService } from './signup-forms.service';
import { SubmitSignupFormDto, UpdateSignupFormDto } from './dto/signup-form.dto';

// Public routes first: a literal "public" must not be swallowed by the ":storeId" seller routes below.
@ApiTags('Signup forms (public)')
@Controller('api/signup-forms/public')
export class PublicSignupFormsController {
  constructor(private readonly service: SignupFormsService) {}

  @Get(':storeId')
  get(@Param('storeId') storeId: string) {
    return this.service.getPublic(storeId);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':storeId/view')
  @HttpCode(202)
  view(@Param('storeId') storeId: string) {
    return this.service.recordView(storeId);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':storeId/submit')
  @HttpCode(200)
  submit(@Param('storeId') storeId: string, @Body() dto: SubmitSignupFormDto) {
    return this.service.submit(storeId, dto.email);
  }
}

@ApiTags('Signup forms')
@ApiBearerAuth()
@AuditStoreWrites('signup_form', 'marketing')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('marketing.manage')
@Controller('api/signup-forms')
export class SignupFormsController {
  constructor(private readonly service: SignupFormsService) {}

  @Get(':storeId')
  get(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.getForSeller(actingSellerId(req.user), storeId);
  }

  @Put(':storeId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateSignupFormDto) {
    return this.service.update(actingSellerId(req.user), storeId, dto);
  }
}
