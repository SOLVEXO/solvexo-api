/* eslint-disable prettier/prettier */
import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SellerAccountDeletionService } from './seller-account-deletion.service';

class RequestDeletionDto {
  /** Password accounts: the current password. */
  @IsOptional() @IsString() password?: string;
  /** Social accounts: a FRESH Google/Apple sign-in (provider id + id token), verified server-side. */
  @IsOptional() @IsIn(['google', 'apple']) authProvider?: 'google' | 'apple';
  @IsOptional() @IsString() socialId?: string;
  @IsOptional() @IsString() token?: string;
}

class PublicOtpRequestDto { @IsEmail() email: string; }
class PublicConfirmDto { @IsEmail() email: string; @IsString() @IsNotEmpty() otp: string; }

/** Owner-only (the owner's own JWT — never a POS device token). */
@ApiTags('Account deletion')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/seller/account-deletion')
export class SellerAccountDeletionController {
  constructor(private readonly service: SellerAccountDeletionService) {}

  @Get()
  status(@Req() req: any) { return this.service.status(req.user.userId); }

  @Post()
  request(@Req() req: any, @Body() dto: RequestDeletionDto) { return this.service.request(req.user.userId, { password: dto.password, authProvider: dto.authProvider, socialId: dto.socialId, token: dto.token }, req.ip); }

  @Post('cancel')
  cancel(@Req() req: any) { return this.service.cancel(req.user.userId); }
}


/** Signed-out account deletion for Google Play's web deletion URL: verify the email with a one-time code, then confirm. */
@ApiTags('Account deletion')
@Controller('api/public/account-deletion')
export class PublicAccountDeletionController {
  constructor(private readonly service: SellerAccountDeletionService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('request-otp')
  requestOtp(@Body() dto: PublicOtpRequestDto) { return this.service.requestPublicOtp(dto.email); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('confirm')
  confirm(@Body() dto: PublicConfirmDto, @Req() req: any) { return this.service.confirmPublic(dto.email, dto.otp, req.ip); }
}
