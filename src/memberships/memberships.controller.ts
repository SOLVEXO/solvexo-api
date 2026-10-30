/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { MembershipsService } from './memberships.service';

class PlanIdDto { @IsString() @IsNotEmpty() planId: string; }
class GrantDto { @IsString() @IsNotEmpty() customerId: string; @IsString() @IsNotEmpty() planId: string; }

/** Public: what a store sells (no auth, no private fields). */
@ApiTags('Memberships (public)')
@Controller('api/public/memberships')
export class PublicMembershipsController {
  constructor(private readonly svc: MembershipsService, private readonly db: DatabaseService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get(':storeId/plans')
  async plans(@Param('storeId') storeId: string) {
    const plans = await this.svc.listPlans(storeId, true);
    const ids = plans.map((p) => p.productId).filter(Boolean) as string[];
    const products: any[] = ids.length ? await this.db.repositories.productModel.find({ _id: { $in: ids }, storeId, isDelete: false, status: 'active' }).select('slug').lean() : [];
    const slugOf = new Map(products.map((x) => [String(x._id), x.slug]));
    return plans.map((p) => ({ productSlug: p.productId ? slugOf.get(String(p.productId)) ?? null : null, _id: p._id, name: p.name, description: p.description, type: p.type, amount: p.amount, currency: p.currency, interval: p.interval, intervalCount: p.intervalCount, trialDays: p.trialDays, benefits: p.benefits, tier: p.tier }));
  }
}

/** Buyer: own memberships only (customerId always from the JWT). */
@ApiTags('Memberships (buyer)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@Controller('api/memberships/me')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class BuyerMembershipsController {
  constructor(private readonly svc: MembershipsService) {}
  private scope = (req: any, q?: string) => resolveBuyerStoreScope(req.user.storeId, q);

  @Get()
  list(@Req() req: any, @Query('storeId') storeId: string) {
    return this.svc.mine(this.scope(req, storeId), req.user.userId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('join')
  join(@Req() req: any, @Query('storeId') storeId: string, @Body() dto: PlanIdDto) {
    return this.svc.join(this.scope(req, storeId), req.user.userId, dto.planId);
  }

  @Post(':id/cancel')
  cancel(@Req() req: any, @Query('storeId') storeId: string, @Param('id') id: string) {
    return this.svc.cancel(this.scope(req, storeId), req.user.userId, id);
  }

  @Post(':id/pause')
  pause(@Req() req: any, @Query('storeId') storeId: string, @Param('id') id: string) {
    return this.svc.pause(this.scope(req, storeId), req.user.userId, id);
  }

  @Post(':id/resume')
  resume(@Req() req: any, @Query('storeId') storeId: string, @Param('id') id: string) {
    return this.svc.resume(this.scope(req, storeId), req.user.userId, id);
  }

  @Post(':id/change-plan')
  change(@Req() req: any, @Query('storeId') storeId: string, @Param('id') id: string, @Body() dto: PlanIdDto) {
    return this.svc.changePlan(this.scope(req, storeId), req.user.userId, id, dto.planId);
  }
}

/** Seller. Permission: members.manage. */
@ApiTags('Memberships (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@Controller('api/memberships/store/:storeId')
@UsePipes(new ValidationPipe({ whitelist: false, transform: true }))
export class SellerMembershipsController {
  constructor(private readonly svc: MembershipsService, private readonly db: DatabaseService, private readonly entitlements: EntitlementsService) {}
  private own = (req: any, storeId: string) => verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
  private by = (req: any) => String(req.user.userId ?? req.user.staffId ?? 'seller');

  @Get('plans') @RequirePermission('members.manage')
  async plans(@Req() req: any, @Param('storeId') storeId: string) { await this.own(req, storeId); return this.svc.listPlans(storeId); }

  @Post('plans') @RequirePermission('members.manage')
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) { await this.own(req, storeId); await this.entitlements.assertFeatureAllowed(storeId, 'digitalMembershipsAllowed', 'Memberships'); return this.svc.createPlan(storeId, body); }

  @Patch('plans/:planId') @RequirePermission('members.manage')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('planId') planId: string, @Body() body: any) { await this.own(req, storeId); return this.svc.updatePlan(storeId, planId, body); }

  @Get('subscribers') @RequirePermission('members.manage')
  async subs(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string, @Query('limit') limit?: string) { await this.own(req, storeId); return this.svc.listSubscribers(storeId, status, Number(limit) || 50); }

  @Post('subscribers/grant') @RequirePermission('members.manage')
  async grant(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GrantDto) { await this.own(req, storeId); return this.svc.sellerGrant(storeId, dto.customerId, dto.planId, this.by(req)); }

  @Post('subscribers/:id/mark-paid') @RequirePermission('members.manage')
  async paid(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) { await this.own(req, storeId); return this.svc.markPaid(storeId, id, this.by(req)); }

  @Post('subscribers/:id/revoke') @RequirePermission('members.manage')
  async revoke(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) { await this.own(req, storeId); return this.svc.sellerRevoke(storeId, id, this.by(req)); }
}
