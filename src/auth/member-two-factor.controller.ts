/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { MemberKind, MemberTwoFactorService } from './member-two-factor.service';
import { clearStaffTwoFactorCache } from './guards/permissions.guard';
import { AuthService } from './auth.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';

class CodeDto { @IsString() @MinLength(6) @MaxLength(20) code: string; }
class PasswordCodeDto extends CodeDto { @IsString() @MinLength(1) @MaxLength(128) password: string; }
class ChallengeDto extends CodeDto { @IsString() @MinLength(20) @MaxLength(2000) challengeToken: string; }
class PolicyDto {
  @IsBoolean() requireStaffTwoFactor: boolean;
  /** Days staff get to set it up before admin routes are refused (0 to 30, default 7). */
  @IsOptional() @IsInt() @Min(0) @Max(30) graceDays?: number;
}

/** Public: second step of a SELLER sign-in when two-factor is on (staff use `POST api/staff/2fa/verify`). */
@ApiTags('Seller Two-Factor')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/auth/seller/2fa')
export class SellerTwoFactorLoginController {
  constructor(private readonly auth: AuthService) {}
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify')
  verify(@Req() req: any, @Body() dto: ChallengeDto) { return this.auth.completeSellerTwoFactorLogin(dto.challengeToken, dto.code, req.ip, req.headers['user-agent']); }
}

/** A signed-in seller or staff member managing their OWN two-factor, plus the owner's store policy and staff reset. */
@ApiTags('Member Two-Factor')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/2fa')
export class MemberTwoFactorController {
  constructor(private readonly svc: MemberTwoFactorService, private readonly activity: ActivityLogService, private readonly db: DatabaseService) {}
  private me(req: any): { kind: MemberKind; id: string } { return { kind: req.user.role === 'staff' ? 'staff' : 'seller', id: String(req.user.userId ?? req.user.sub ?? req.user.id) }; }

  @Roles('seller', 'staff') @Get('me')
  async status(@Req() req: any) { const m = this.me(req); return { success: true, data: await this.svc.status(m.kind, m.id) }; }

  @Roles('seller', 'staff') @Post('me/setup') @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async setup(@Req() req: any) { const m = this.me(req); return { success: true, data: await this.svc.startSetup(m.kind, m.id, String(req.user.email ?? 'account')) }; }

  @Roles('seller', 'staff') @Post('me/enable') @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async enable(@Req() req: any, @Body() dto: CodeDto) { const m = this.me(req); const data = await this.svc.confirmSetup(m.kind, m.id, dto.code); clearStaffTwoFactorCache(); return { success: true, message: 'Two-factor sign-in is on.', data }; }

  @Roles('seller', 'staff') @Post('me/disable') @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async disable(@Req() req: any, @Body() dto: PasswordCodeDto) { const m = this.me(req); await this.svc.disable(m.kind, m.id, dto.password, dto.code); clearStaffTwoFactorCache(); return { success: true, message: 'Two-factor sign-in is off.' }; }

  @Roles('seller', 'staff') @Post('me/recovery-codes') @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async codes(@Req() req: any, @Body() dto: PasswordCodeDto) { const m = this.me(req); return { success: true, data: await this.svc.regenerate(m.kind, m.id, dto.password, dto.code) }; }

  /** Fresh code -> 10-minute token for the `x-step-up` header on sensitive actions. */
  @Roles('seller', 'staff') @Post('me/step-up') @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async stepUp(@Req() req: any, @Body() dto: CodeDto) { const m = this.me(req); return { success: true, data: await this.svc.issueStepUp(m.kind, m.id, dto.code) }; }

  /** Owner only: require staff of this store to use two-factor (see docs: enforced as "setup required" flag at staff login). */
  @Roles('seller') @Put('store/:storeId/policy')
  async policy(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: PolicyDto) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, String(req.user.userId ?? req.user.sub));
    const before: any = await this.db.repositories.storeModel.findById(storeId).select('requireStaffTwoFactor staffTwoFactorGraceDays').lean();
    const set: Record<string, unknown> = { requireStaffTwoFactor: dto.requireStaffTwoFactor };
    if (dto.graceDays !== undefined) set.staffTwoFactorGraceDays = dto.graceDays;
    // The grace period runs from the moment the policy is switched on.
    if (dto.requireStaffTwoFactor && !before?.requireStaffTwoFactor) set.requireStaffTwoFactorSince = new Date();
    if (!dto.requireStaffTwoFactor) set.requireStaffTwoFactorSince = null;
    await this.db.repositories.storeModel.updateOne({ _id: storeId }, { $set: set });
    clearStaffTwoFactorCache();
    void this.activity.log({ storeId, category: 'security', action: 'staff_2fa_policy', description: `Require two-factor for staff: ${dto.requireStaffTwoFactor}`, actorId: String(req.user.userId ?? req.user.sub), actorRole: 'seller', targetId: storeId, targetType: 'store' } as any).catch(() => undefined);
    return { success: true, data: { requireStaffTwoFactor: dto.requireStaffTwoFactor, graceDays: dto.graceDays ?? before?.staffTwoFactorGraceDays ?? 7 } };
  }

  /** Owner: the policy and which staff members already use two-factor (for the Security and Staff pages). */
  @Roles('seller') @Get('store/:storeId/policy')
  async policyState(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, String(req.user.userId ?? req.user.sub));
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('requireStaffTwoFactor requireStaffTwoFactorSince staffTwoFactorGraceDays').lean();
    const staff: any[] = await this.db.repositories.staffMemberModel.find({ storeId, isDelete: false }).select('_id').lean();
    const enabled = new Set((await Promise.all(staff.map(async (s) => ((await this.svc.isEnabled('staff', String(s._id))) ? String(s._id) : null)))).filter(Boolean) as string[]);
    const graceEnds = store?.requireStaffTwoFactor && store.requireStaffTwoFactorSince ? new Date(new Date(store.requireStaffTwoFactorSince).getTime() + (store.staffTwoFactorGraceDays ?? 7) * 86_400_000) : null;
    return { success: true, data: { requireStaffTwoFactor: !!store?.requireStaffTwoFactor, graceDays: store?.staffTwoFactorGraceDays ?? 7, graceEndsAt: graceEnds, staffWithTwoFactor: [...enabled] } };
  }

  /** Owner (or a platform admin) resets a staff member's two-factor after a lost phone. Audited. */
  @Roles('seller', 'admin') @Post('store/:storeId/staff/:staffId/reset')
  async resetStaff(@Req() req: any, @Param('storeId') storeId: string, @Param('staffId') staffId: string) {
    if (req.user.role === 'seller') await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, String(req.user.userId ?? req.user.sub));
    let staff: any = null;
    try { staff = await this.db.repositories.staffMemberModel.findOne({ _id: staffId, storeId, isDelete: false }).select('_id email').lean(); } catch { /* invalid id */ }
    if (!staff) throw new NotFoundException('Staff member not found');
    if (!(await this.svc.isEnabled('staff', staffId))) throw new BadRequestException('This person has not turned on two-factor.');
    await this.svc.reset('staff', staffId);
    clearStaffTwoFactorCache();
    void this.activity.log({ storeId, category: 'security', action: 'staff_2fa_reset', description: `Two-factor reset for ${staff.email}`, actorId: String(req.user.userId ?? req.user.sub), actorRole: req.user.role, targetId: staffId, targetType: 'staff' } as any).catch(() => undefined);
    return { success: true, message: 'Two-factor was reset. They can set it up again.' };
  }
}
