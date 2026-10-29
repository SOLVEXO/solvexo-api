/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { Roles } from './decorators/roles.decorator';
import { AdminSelf } from './decorators/admin-guards.decorator';
import { AdminTwoFactorService } from './admin-two-factor.service';
import { AuthService } from './auth.service';

class CodeDto { @IsString() @MinLength(6) @MaxLength(20) code: string; }
class PasswordCodeDto extends CodeDto { @IsString() @MinLength(1) @MaxLength(128) password: string; }
class ChallengeDto extends CodeDto { @IsString() @MinLength(20) @MaxLength(2000) challengeToken: string; }

/** Public: the second step of an admin sign-in when two-factor is on. */
@ApiTags('Admin Two-Factor')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/auth/admin/2fa')
export class AdminTwoFactorLoginController {
  constructor(private readonly auth: AuthService) {}

  // Same limit as the password step; the account lockout (5 wrong tries) also counts wrong codes.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify')
  verify(@Req() req: any, @Body() dto: ChallengeDto) {
    return this.auth.completeAdminTwoFactorLogin(dto.challengeToken, dto.code, req.ip, req.headers['user-agent']);
  }
}

/** Signed-in admin: turn two-factor on or off for their own account. */
@ApiTags('Admin Two-Factor')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/2fa')
export class AdminTwoFactorController {
  constructor(private readonly twoFactor: AdminTwoFactorService) {}

  @AdminSelf()
  @Get()
  status(@Req() req: any) { return this.twoFactor.status(req.user.userId); }

  @AdminSelf()
  @Post('setup')
  setup(@Req() req: any) { return this.twoFactor.startSetup(req.user.userId); }

  @AdminSelf()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('enable')
  enable(@Req() req: any, @Body() dto: CodeDto) { return this.twoFactor.confirmSetup(req.user.userId, dto.code); }

  @AdminSelf()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('disable')
  disable(@Req() req: any, @Body() dto: PasswordCodeDto) { return this.twoFactor.disable(req.user.userId, dto.password, dto.code); }

  @AdminSelf()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('recovery-codes')
  recoveryCodes(@Req() req: any, @Body() dto: PasswordCodeDto) { return this.twoFactor.regenerateRecoveryCodes(req.user.userId, dto.password, dto.code); }
}
