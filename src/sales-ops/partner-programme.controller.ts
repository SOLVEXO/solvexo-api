/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { KYC_DOCUMENT_MAX_BYTES } from '../upload/upload-file-validation';
import { type PartnerApplicationInput, PartnerOnboardingService, type PartnerProfileInput } from './partner-onboarding.service';
import { type DealInput, PartnerDealsService } from './partner-deals.service';
import { PartnerScorecardService } from './partner-scorecard.service';
import type { ProgrammeSettings } from './partner-programme.util';
import { salesActor } from './sales-ops.util';

const fileUpload = () => FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: KYC_DOCUMENT_MAX_BYTES } });

/** "Become a partner" on solvexo.store. */
@Controller('api/partners')
export class PartnerApplyController {
  constructor(private readonly svc: PartnerOnboardingService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('apply')
  apply(@Req() req: any, @Body() dto: PartnerApplicationInput & { website2?: string }) {
    // Honeypot (a hidden field people never fill): answer like a success, save nothing.
    if (typeof dto?.website2 === 'string' && dto.website2.trim()) return { success: true, message: 'Thank you. We have your application and will contact you within 2 working days.' };
    return this.svc.apply(dto ?? {}, req.ip);
  }
}

/** Super Admin → Sales → Partners: applications, vetting, agreement and onboarding. */
@ApiTags('Admin Partner Programme')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@RequirePermission('sales.manage')
@Controller('api/admin/sales/partner-programme')
export class PartnerProgrammeController {
  constructor(private readonly svc: PartnerOnboardingService, private readonly deals: PartnerDealsService, private readonly scores: PartnerScorecardService) {}

  // ── Scorecard (B13) ──
  @Get('scorecards')
  leaderboard() { return this.scores.leaderboard(); }

  @Get('scorecards/:id')
  scorecard(@Param('id') id: string) { return this.scores.detail(id); }

  @Post('scorecards/:id/log')
  addLog(@Req() req: any, @Param('id') id: string, @Body() dto: { type?: string; summary?: string; details?: string; plan?: string; about?: string; at?: string; visibleToPartner?: boolean }) {
    return this.scores.addLog(salesActor(req.user), id, dto ?? {});
  }

  @Post('scorecards/:id/conduct')
  conduct(@Req() req: any, @Param('id') id: string, @Body() dto: { action?: string; reason?: string; details?: string; plan?: string; dueAt?: string }) {
    return this.scores.conduct(salesActor(req.user), id, dto ?? {});
  }

  @Post('scorecards/:id/log/:logId/resolve')
  resolve(@Param('id') id: string, @Param('logId') logId: string) { return this.scores.resolveComplaint(id, logId); }

  // ── Deal registration (B7) ──
  @Get('deals')
  dealList(@Query('status') status?: string, @Query('partnerId') partnerId?: string) { return this.deals.list({ status, partnerId }); }

  @Post('deals/:id/decision')
  decide(@Req() req: any, @Param('id') id: string, @Body() dto: { decision?: 'accept' | 'reject'; reason?: string }) { return this.deals.decide(salesActor(req.user), id, dto ?? {}); }

  @Post('deals/:id/extend')
  extend(@Req() req: any, @Param('id') id: string, @Body() dto: { days?: number; progress?: string; note?: string }) { return this.deals.extend(salesActor(req.user), id, dto ?? {}); }

  @Post('deals/:id/lost')
  lost(@Param('id') id: string) { return this.deals.close(id, 'lost'); }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('deals/run')
  runDeals() { return this.deals.run().then((data) => ({ success: true, data })); }

  @Get('settings')
  settings() { return this.svc.getSettings(); }

  @Patch('settings')
  saveSettings(@Req() req: any, @Body() dto: Partial<ProgrammeSettings>) { return this.svc.saveSettings(salesActor(req.user), dto); }

  @Get('board')
  board() { return this.svc.board(); }

  @Get('partners/:id')
  detail(@Param('id') id: string) { return this.svc.detail(id); }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('partners/:id/invite')
  invite(@Req() req: any, @Param('id') id: string) { return this.svc.invite(salesActor(req.user), id); }

  @Post('partners/:id/reject')
  reject(@Req() req: any, @Param('id') id: string, @Body() dto: { reason?: string }) { return this.svc.reject(salesActor(req.user), id, dto?.reason ?? ''); }

  @Post('partners/:id/reopen')
  reopen(@Param('id') id: string) { return this.svc.reopen(id); }

  @Patch('partners/:id/profile')
  profile(@Param('id') id: string, @Body() dto: PartnerProfileInput) { return this.svc.updateProfile(id, dto ?? {}); }

  @Post('partners/:id/approve')
  approve(@Req() req: any, @Param('id') id: string) { return this.svc.approve(salesActor(req.user), id); }

  @Post('partners/:id/agreement')
  agreement(@Req() req: any, @Param('id') id: string, @Body() dto: { signedAt?: string; version?: string; entity?: string; note?: string }) {
    return this.svc.signAgreement(salesActor(req.user), id, dto ?? {});
  }

  @Post('partners/:id/checklist/:key')
  tick(@Req() req: any, @Param('id') id: string, @Param('key') key: string, @Body() dto: { done?: boolean }) {
    return this.svc.tick(salesActor(req.user), id, key, dto?.done !== false);
  }

  @Patch('partners/:id/staff')
  staff(@Req() req: any, @Param('id') id: string, @Body() dto: { staff?: any[] }) { return this.svc.saveStaff(id, dto?.staff ?? [], salesActor(req.user)); }

  @Patch('partners/:id/demo-stores')
  demoStores(@Param('id') id: string, @Body() dto: { stores?: string[] }) { return this.svc.setDemoStores(id, dto?.stores ?? []); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('partners/:id/documents')
  @UseInterceptors(fileUpload())
  upload(@Req() req: any, @Param('id') id: string, @Body() dto: { type?: string }, @UploadedFile() file: Express.Multer.File) {
    return this.svc.uploadDoc(id, dto?.type ?? '', file, { adminId: salesActor(req.user).adminId, role: 'manager' });
  }

  @Post('partners/:id/documents/:docId/review')
  review(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string, @Body() dto: { status?: 'verified' | 'rejected'; note?: string }) {
    return this.svc.reviewDoc(salesActor(req.user), id, docId, dto?.status as any, dto?.note);
  }

  @Get('partners/:id/documents/:docId/url')
  docUrl(@Param('id') id: string, @Param('docId') docId: string) { return this.svc.docUrl(id, docId); }
}

/** The partner's own onboarding: documents to upload, checklist, agreement dates. */
@ApiTags('Admin Partner Portal')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@RequirePermission('partner.portal', 'sales.access', 'sales.manage')
@Controller('api/admin/partner-portal/onboarding')
export class PartnerPortalOnboardingController {
  constructor(private readonly svc: PartnerOnboardingService) {}

  @Get()
  mine(@Req() req: any) { return this.svc.mine(salesActor(req.user)); }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('documents')
  @UseInterceptors(fileUpload())
  upload(@Req() req: any, @Body() dto: { type?: string }, @UploadedFile() file: Express.Multer.File) {
    return this.svc.uploadMine(salesActor(req.user), dto?.type ?? '', file);
  }

  @Get('documents/:docId/url')
  docUrl(@Req() req: any, @Param('docId') docId: string) { return this.svc.myDocUrl(salesActor(req.user), docId); }
}

/** The partner's deal registrations (B7). */
@ApiTags('Admin Partner Portal')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@RequirePermission('partner.portal', 'sales.access', 'sales.manage')
@Controller('api/admin/partner-portal/deals')
export class PartnerPortalDealsController {
  constructor(private readonly deals: PartnerDealsService) {}

  @Get()
  mine(@Req() req: any) { return this.deals.mine(salesActor(req.user)); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  register(@Req() req: any, @Body() dto: DealInput) { return this.deals.register(salesActor(req.user), dto ?? {}); }

  @Post(':id/extension')
  extension(@Req() req: any, @Param('id') id: string, @Body() dto: { progress?: string; note?: string }) { return this.deals.requestExtension(salesActor(req.user), id, dto ?? {}); }
}

/** The partner's own scorecard (B13). */
@ApiTags('Admin Partner Portal')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@RequirePermission('partner.portal', 'sales.access', 'sales.manage')
@Controller('api/admin/partner-portal/scorecard')
export class PartnerPortalScorecardController {
  constructor(private readonly scores: PartnerScorecardService) {}

  @Get()
  mine(@Req() req: any) { return this.scores.mine(salesActor(req.user)); }
}
