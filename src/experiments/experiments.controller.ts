/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { PUBLIC_BROWSE_LIMIT } from '../storefront/public-throttle';
import { ExperimentsService } from './experiments.service';

/** Seller side: A/B experiments of the store. Permissions: experiments.view / experiments.manage. */
@ApiTags('Experiments (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/experiments/:storeId')
export class ExperimentsController {
  constructor(private readonly svc: ExperimentsService, private readonly db: DatabaseService) {}
  private async own(req: any, storeId: string): Promise<{ id: string; role: string }> {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
    return { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) };
  }

  @Get() @RequirePermission('experiments.view')
  async list(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.list(s); }
  @Post() @RequirePermission('experiments.manage')
  async create(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { return this.svc.create(s, await this.own(req, s), b); }
  @Get(':id/results') @RequirePermission('experiments.view')
  async results(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(req, s); return this.svc.results(s, id); }
  @Patch(':id') @RequirePermission('experiments.manage')
  async update(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.update(s, await this.own(req, s), id, b); }
  @Delete(':id') @RequirePermission('experiments.manage')
  async remove(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { return this.svc.remove(s, await this.own(req, s), id); }
  @Post(':id/winner') @RequirePermission('experiments.manage')
  async winner(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.applyWinner(s, await this.own(req, s), id, String(b?.winner ?? '')); }
  @Post(':id/:action') @RequirePermission('experiments.manage')
  async action(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Param('action') action: string) {
    if (!['start', 'pause', 'resume', 'stop'].includes(action)) throw new NotFoundException('Unknown action');
    return this.svc.transition(s, await this.own(req, s), id, action as 'start' | 'pause' | 'resume' | 'stop');
  }
}

/** Storefront (anonymous): what to show this visitor, and "this visit joined test X". Behind the password-store gate. */
@ApiTags('Experiments (public)')
@Throttle(PUBLIC_BROWSE_LIMIT)
@Controller('api/public/experiments')
export class PublicExperimentsController {
  constructor(private readonly svc: ExperimentsService, private readonly db: DatabaseService) {}
  private async liveStore(storeId: string) {
    const s: any = await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('_id').lean();
    if (!s) throw new NotFoundException('Store not found');
  }
  @Get(':storeId/assignments')
  async assignments(@Param('storeId') storeId: string, @Query('visitorId') visitorId?: string) { await this.liveStore(storeId); return this.svc.assignments(storeId, String(visitorId ?? '')); }
  @Post(':storeId/exposure')
  async exposure(@Param('storeId') storeId: string, @Body() body: any) {
    if (!body || typeof body !== 'object') throw new BadRequestException('Invalid body');
    await this.liveStore(storeId);
    return this.svc.recordExposure(storeId, { sessionId: String(body.sessionId ?? ''), visitorId: String(body.visitorId ?? ''), experimentId: String(body.experimentId ?? '') });
  }
}
