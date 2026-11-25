/* eslint-disable prettier/prettier */
import { SalesAccessService } from './sales-access.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { SalesOpsService } from './sales-ops.service';
import { SalesCaptureService } from './sales-capture.service';
import { SalesGrowthService } from './sales-growth.service';
import { SalesPartnersService } from './sales-partners.service';
import { SalesAgentService } from './sales-agent.service';
import { SalesWhatsAppService } from './sales-whatsapp.service';
import { SalesVisitsService } from './sales-visits.service';
import { type AuditCtx, SalesBrevoService } from './sales-brevo.service';
import { salesActor } from './sales-ops.util';
import {
  ActivityDto,
  BrevoConnectDto,
  ConsentRequestsDto,
  WaConnectDto,
  WaTemplatesDto,
  RepAccessDto,
  WaSendTemplateDto,
  WaListDto,
  WaSendDto,
  AgentPreviewDto,
  AgentSettingsDto,
  ChatMessageDto,
  ChatStartDto,
  DraftDto,
  AdjustmentDto,
  CommissionPlanDto,
  PartnerDto,
  PayoutDto,
  ReferralDto,
  CampaignDto,
  SalesSettingsDto,
  SpendDto,
  TargetsDto,
  DemoRequestDto,
  EmailDto,
  ImportDto,
  LeadDto,
  LeadListDto,
  StageDto,
  TaskDto,
  TaskListDto,
  TaskPatchDto,
  TemplateDto,
  VisitCheckDto,
  VisitDto,
  VisitListDto,
  VisitPatchDto,
} from './sales-ops.dto';

/** Who did it, for the admin audit log (never the request body). */
const auditCtx = (req: any): AuditCtx => ({
  adminId: req?.user?.userId ?? null,
  adminEmail: req?.user?.email ?? null,
  ip: req?.ip ?? null,
  userAgent: req?.headers?.['user-agent'] ?? null,
});

/** Super Admin → Sales Ops. `sales.access` = a rep (own leads only); `sales.manage` = every lead and the settings. */
@ApiTags('Admin Sales Ops')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@RequirePermission('sales.access', 'sales.manage')
@Controller('api/admin/sales')
export class SalesOpsController {
  constructor(
    private readonly sales: SalesOpsService,
    private readonly capture: SalesCaptureService,
    private readonly growth: SalesGrowthService,
    private readonly partners: SalesPartnersService,
    private readonly agent: SalesAgentService,
    private readonly whatsapp: SalesWhatsAppService,
    private readonly access: SalesAccessService,
    private readonly visits: SalesVisitsService,
    private readonly brevo: SalesBrevoService,
  ) {}

  // ── Brevo (marketing email) ─────────────────────────────────────────────────

  /** Connection + sync counts. Reps may look; only managers change anything. */
  @Get('brevo')
  brevoStatus() {
    return this.brevo.status();
  }

  @RequirePermission('sales.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('brevo')
  brevoConnect(@Req() req: any, @Body() dto: BrevoConnectDto) {
    return this.brevo.connect(dto.apiKey, auditCtx(req));
  }

  @RequirePermission('sales.manage')
  @Delete('brevo')
  brevoDisconnect(@Req() req: any) {
    return this.brevo.disconnect(auditCtx(req));
  }

  @RequirePermission('sales.manage')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('brevo/sync')
  brevoSync(@Req() req: any) {
    return this.brevo.syncNow(auditCtx(req));
  }

  /** Brevo import file: the leads the list shows with these filters, only those who agreed to marketing email. */
  @RequirePermission('sales.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('leads/export/brevo')
  async brevoExport(
    @Req() req: any,
    @Query() q: LeadListDto,
    @Res() res: Response,
  ) {
    const { filename, csv } = await this.brevo.exportCsv(
      salesActor(req.user),
      q,
      auditCtx(req),
    );
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    res.send(csv);
  }

  /** One "Can we keep you posted?" email per lead that was never asked. */
  @RequirePermission('sales.manage')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('leads/consent-requests')
  consentRequests(@Req() req: any, @Body() dto: ConsentRequestsDto) {
    return this.brevo.requestConsent(
      salesActor(req.user),
      { leadIds: dto.leadIds, filters: { stage: dto.stage, owner: dto.owner, source: dto.source, q: dto.q, due: dto.due, consent: dto.consent } },
      auditCtx(req),
    );
  }

  // ── WhatsApp (Solvexo's own number) ────────────────────────────────────────

  @RequirePermission('sales.manage')
  @Get('whatsapp/connection')
  waConnection() {
    return this.whatsapp.getConnection();
  }

  @RequirePermission('sales.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('whatsapp/connection')
  waConnect(@Body() dto: WaConnectDto) {
    return this.whatsapp.connect(dto);
  }

  /** The approved templates reps can pick from; each is checked with Meta. */
  @RequirePermission('sales.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('whatsapp/templates')
  waTemplates(@Body() dto: WaTemplatesDto) {
    return this.whatsapp.saveTemplates(dto.templates);
  }

  @RequirePermission('sales.manage')
  @Delete('whatsapp/connection')
  waDisconnect() {
    return this.whatsapp.disconnect();
  }

  @Get('whatsapp/conversations')
  waList(@Req() req: any, @Query() q: WaListDto) {
    return this.whatsapp.listConversations(salesActor(req.user), {
      leadId: q.leadId,
      unread: q.unread === 'true',
    });
  }

  @Get('whatsapp/conversations/:id')
  waGet(@Req() req: any, @Param('id') id: string) {
    return this.whatsapp.getConversation(salesActor(req.user), id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('whatsapp/conversations/:id/send')
  waSend(@Req() req: any, @Param('id') id: string, @Body() dto: WaSendDto) {
    return this.whatsapp.send(
      salesActor(req.user),
      id,
      dto.text,
      !!dto.fromAiDraft,
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('whatsapp/conversations/:id/template')
  waTemplate(@Req() req: any, @Param('id') id: string, @Body() dto: WaSendTemplateDto) {
    return this.whatsapp.sendTemplate(salesActor(req.user), id, dto?.key ?? null);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('whatsapp/conversations/:id/draft')
  waRedraft(@Req() req: any, @Param('id') id: string) {
    return this.whatsapp.redraft(salesActor(req.user), id);
  }

  @Delete('whatsapp/conversations/:id/draft')
  waDiscardDraft(@Req() req: any, @Param('id') id: string) {
    return this.whatsapp.discardDraft(salesActor(req.user), id);
  }

  @Post('leads/:id/whatsapp')
  waOpenForLead(@Req() req: any, @Param('id') id: string) {
    return this.whatsapp.openForLead(salesActor(req.user), id);
  }

  // ── AI sales agent ───────────────────────────────────────────────────────

  @RequirePermission('sales.manage')
  @Get('ai-agent')
  agentConfig() {
    return this.agent.getConfig();
  }

  @RequirePermission('sales.manage')
  @Put('ai-agent')
  saveAgentConfig(@Body() dto: AgentSettingsDto) {
    return this.agent.saveConfig(dto);
  }

  @RequirePermission('sales.manage')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('ai-agent/preview')
  previewAgent(@Body() dto: AgentPreviewDto) {
    return this.agent.preview(dto.message, dto.history ?? []);
  }

  @RequirePermission('sales.manage')
  @Get('ai-agent/chats')
  agentChats() {
    return this.agent.recentChats(50);
  }

  @Get('leads/:id/chats')
  leadChats(@Req() req: any, @Param('id') id: string) {
    return this.agent.leadChats(salesActor(req.user), id);
  }

  /** Mark the AI's draft as sent (logs it) or discard it. */
  @Post('leads/:id/ai-draft')
  resolveDraft(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: DraftDto,
  ) {
    return this.agent.resolveDraft(salesActor(req.user), id, dto.sent);
  }

  // ── Partners & commissions (managers; payouts also need finance.payouts) ──

  @RequirePermission('sales.manage')
  @Get('commission-plans')
  plans() {
    return this.partners.listPlans();
  }

  @RequirePermission('sales.manage')
  @Post('commission-plans')
  createPlan(@Body() dto: CommissionPlanDto) {
    return this.partners.savePlan(null, dto);
  }

  @RequirePermission('sales.manage')
  @Patch('commission-plans/:id')
  updatePlan(@Param('id') id: string, @Body() dto: CommissionPlanDto) {
    return this.partners.savePlan(id, dto);
  }

  @RequirePermission('sales.manage')
  @Get('partner-logins')
  partnerLogins() {
    return this.partners.logins();
  }

  @RequirePermission('sales.manage')
  @Get('partners')
  listPartners() {
    return this.partners.listPartners();
  }

  @RequirePermission('sales.manage')
  @Get('partners/:id')
  partner(@Param('id') id: string) {
    return this.partners.getPartner(id);
  }

  @RequirePermission('sales.manage')
  @Post('partners')
  createPartner(@Req() req: any, @Body() dto: PartnerDto) {
    return this.partners.savePartner(salesActor(req.user), null, dto);
  }

  @RequirePermission('sales.manage')
  @Patch('partners/:id')
  updatePartner(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: PartnerDto,
  ) {
    return this.partners.savePartner(salesActor(req.user), id, dto);
  }

  @RequirePermission('sales.manage')
  @Post('partners/:id/referrals')
  addReferral(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ReferralDto,
  ) {
    return this.partners.setReferral(salesActor(req.user), id, dto);
  }

  @RequirePermission('sales.manage')
  @Delete('partners/:id/referrals/:sellerId')
  removeReferral(@Param('id') id: string, @Param('sellerId') sellerId: string) {
    return this.partners.removeReferral(id, sellerId);
  }

  /** B4.4: written 60-day notice that the partner stopped supporting a seller (or withdraw it with cancel: true). */
  @RequirePermission('sales.manage')
  @Post('partners/:id/referrals/:sellerId/support-notice')
  supportNotice(@Req() req: any, @Param('id') id: string, @Param('sellerId') sellerId: string, @Body() dto: { reason?: string; cancel?: boolean }) {
    return this.partners.supportNotice(salesActor(req.user), id, sellerId, dto ?? {});
  }

  @RequirePermission('sales.manage')
  @Post('partners/:id/adjustments')
  adjustment(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: AdjustmentDto,
  ) {
    return this.partners.addAdjustment(salesActor(req.user), id, dto);
  }

  @RequirePermission('sales.manage')
  @Get('partners/:id/statement')
  partnerStatement(@Param('id') id: string, @Query('month') month?: string) {
    return this.partners.statementFor(id, month);
  }

  /** Money out: needs the finance payouts permission (the owner / Super Admins always can). */
  @RequirePermission('finance.payouts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('partners/:id/payouts')
  payout(@Req() req: any, @Param('id') id: string, @Body() dto: PayoutDto) {
    return this.partners.recordPayout(salesActor(req.user), id, dto);
  }

  /** Run the daily commission calculation now. */
  @RequirePermission('sales.manage')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('commissions/run')
  runCommissions() {
    return this.partners.run();
  }

  // ── Campaigns (managers) ───────────────────────────────────────────────────

  @RequirePermission('sales.manage')
  @Get('campaigns')
  campaigns(@Query('archived') archived?: string) {
    return this.growth.listCampaigns(archived === 'true');
  }

  @RequirePermission('sales.manage')
  @Get('campaigns/:id')
  campaign(@Param('id') id: string) {
    return this.growth.getCampaign(id);
  }

  @RequirePermission('sales.manage')
  @Post('campaigns')
  createCampaign(@Req() req: any, @Body() dto: CampaignDto) {
    return this.growth.saveCampaign(salesActor(req.user), null, dto);
  }

  @RequirePermission('sales.manage')
  @Patch('campaigns/:id')
  updateCampaign(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: CampaignDto,
  ) {
    return this.growth.saveCampaign(salesActor(req.user), id, dto);
  }

  @RequirePermission('sales.manage')
  @Post('campaigns/:id/spend')
  addSpend(@Req() req: any, @Param('id') id: string, @Body() dto: SpendDto) {
    return this.growth.addSpend(salesActor(req.user), id, dto);
  }

  @RequirePermission('sales.manage')
  @Delete('campaigns/:id/spend/:spendId')
  removeSpend(@Param('id') id: string, @Param('spendId') spendId: string) {
    return this.growth.removeSpend(id, spendId);
  }

  // ── Team ─────────────────────────────────────────────────────────────────

  /** Leaderboard for a month: everyone in sales sees it; only managers set targets. */
  @Get('team')
  team(@Query('month') month?: string) {
    return this.growth.team(month);
  }

  @RequirePermission('sales.manage')
  @Put('targets')
  saveTargets(@Req() req: any, @Body() dto: TargetsDto) {
    return this.growth.saveTargets(
      salesActor(req.user),
      dto.month,
      dto.targets,
    );
  }

  @RequirePermission('sales.manage')
  @Get('settings')
  getSettings() {
    return this.growth.getSettings();
  }

  @RequirePermission('sales.manage')
  @Put('settings')
  saveSettings(@Body() dto: SalesSettingsDto) {
    return this.growth.saveSettings(dto);
  }

  // ── Lead capture ─────────────────────────────────────────────────────────

  /** CSV import (parsed in the browser). `dryRun` checks the file without saving. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('imports')
  importLeads(@Req() req: any, @Body() dto: ImportDto) {
    return this.capture.importLeads(
      salesActor(req.user),
      dto.rows,
      {
        ownerAdminId: dto.ownerAdminId,
        sourceDetail: dto.sourceDetail,
        tags: dto.tags,
      },
      !!dto.dryRun,
    );
  }

  /** "Add to pipeline" on a Contact Us message. */
  @Post('contact-messages/:id/lead')
  fromContact(@Req() req: any, @Param('id') id: string) {
    return this.capture.addContactToPipeline(salesActor(req.user), id);
  }

  /** Run the daily stalled sign-up check now. */
  @RequirePermission('sales.manage')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('stalled/sync')
  syncStalled() {
    return this.capture.syncStalled();
  }

  // ── Field visits ───────────────────────────────────────────────────────────

  @Get('visits') listVisits(@Req() req: any, @Query() q: VisitListDto) {
    return this.visits.list(salesActor(req.user), q);
  }
  @Get('visits/areas') visitAreas() {
    return this.visits.areas();
  }
  /** Earlier visits to the same shop, for the form's "already visited" warning. */
  @Get('visits/check') checkVisit(@Query() q: VisitCheckDto) {
    return this.visits.check(q.phone, q.storeName, q.area);
  }
  // A synced queue can send several visits in a row; 60 a minute is far above what a rep can fill by hand.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('visits') createVisit(@Req() req: any, @Body() dto: VisitDto) {
    return this.visits.create(salesActor(req.user), dto);
  }
  @Get('visits/:id') getVisit(@Req() req: any, @Param('id') id: string) {
    return this.visits.get(salesActor(req.user), id);
  }
  @Patch('visits/:id') updateVisit(@Req() req: any, @Param('id') id: string, @Body() dto: VisitPatchDto) {
    return this.visits.update(salesActor(req.user), id, dto);
  }

  @Get('leads') list(@Req() req: any, @Query() q: LeadListDto) {
    return this.sales.list(salesActor(req.user), q);
  }
  @Post('leads') create(@Req() req: any, @Body() dto: LeadDto) {
    return this.sales.create(salesActor(req.user), dto);
  }
  @Get('leads/:id') get(@Req() req: any, @Param('id') id: string) {
    return this.sales.get(salesActor(req.user), id);
  }
  @Patch('leads/:id') update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: LeadDto,
  ) {
    return this.sales.update(salesActor(req.user), id, dto);
  }
  @Delete('leads/:id') remove(@Req() req: any, @Param('id') id: string) {
    return this.sales.remove(salesActor(req.user), id);
  }
  @Post('leads/:id/stage') stage(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: StageDto,
  ) {
    return this.sales.changeStage(
      salesActor(req.user),
      id,
      dto.stage,
      dto.lostReason,
      dto.note,
    );
  }
  @Post('leads/:id/activities') activity(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ActivityDto,
  ) {
    return this.sales.addActivity(
      salesActor(req.user),
      id,
      dto.type,
      dto.body,
      dto.outcome,
    );
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('leads/:id/email')
  email(@Req() req: any, @Param('id') id: string, @Body() dto: EmailDto) {
    return this.sales.sendEmail(
      salesActor(req.user),
      id,
      dto.subject,
      dto.body,
      dto.templateId ?? null,
    );
  }

  @Post('leads/:id/tasks') createTask(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: TaskDto,
  ) {
    return this.sales.createTask(
      salesActor(req.user),
      id,
      dto.title,
      dto.dueAt,
      dto.assigneeAdminId,
    );
  }
  @Get('tasks') tasks(@Req() req: any, @Query() q: TaskListDto) {
    return this.sales.listTasks(salesActor(req.user), q);
  }
  @Patch('tasks/:id') updateTask(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: TaskPatchDto,
  ) {
    return this.sales.updateTask(salesActor(req.user), id, dto);
  }
  @Delete('tasks/:id') deleteTask(@Req() req: any, @Param('id') id: string) {
    return this.sales.deleteTask(salesActor(req.user), id);
  }

  @Get('owners') owners() {
    return this.sales.owners();
  }
  @Get('templates') templates(@Req() req: any) {
    return this.sales.listTemplates(salesActor(req.user));
  }

  /** What the signed-in person may send to clients (managers: everything). */
  @Get('messaging/me') async myMessaging(@Req() req: any) {
    return { success: true, data: await this.sales.rules(salesActor(req.user)) };
  }

  /** Sales Ops → Team: what each rep may send (reps without saved rules use the defaults). */
  @RequirePermission('sales.manage')
  @Get('team/messaging')
  async teamMessaging() {
    return { success: true, data: await this.access.list() };
  }

  @RequirePermission('sales.manage')
  @Put('team/messaging/:adminId')
  saveTeamMessaging(@Param('adminId') adminId: string, @Body() dto: RepAccessDto) {
    return this.access.save(adminId, dto);
  }

  @RequirePermission('sales.manage')
  @Post('templates')
  createTemplate(@Body() dto: TemplateDto) {
    return this.sales.saveTemplate(null, dto);
  }
  @RequirePermission('sales.manage')
  @Patch('templates/:id')
  updateTemplate(@Param('id') id: string, @Body() dto: TemplateDto) {
    return this.sales.saveTemplate(id, dto);
  }
  @RequirePermission('sales.manage')
  @Delete('templates/:id')
  deleteTemplate(@Param('id') id: string) {
    return this.sales.deleteTemplate(id);
  }
}

/** The public Book-a-demo form on solvexo.store (no login). */
@ApiTags('Sales (public)')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/sales')
export class SalesPublicController {
  constructor(
    private readonly capture: SalesCaptureService,
    private readonly agent: SalesAgentService,
    private readonly brevo: SalesBrevoService,
  ) {}

  /** "Yes, keep me posted" in the permission email: a signed 60-day link. Always redirects to the website. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('consent/:token')
  async confirmConsent(
    @Param('token') token: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    return res.redirect(
      302,
      await this.brevo.confirmConsent(token, req?.ip ?? null),
    );
  }

  /** Brevo's marketing webhook (unsubscribed / spam / hard bounce). The secret in the URL is the credential. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('brevo/webhook/:secret')
  @HttpCode(200)
  brevoWebhook(@Param('secret') secret: string, @Body() body: unknown) {
    return this.brevo.webhook(secret, body);
  }

  /** Is the website chat on? (The widget stays hidden when it isn't.) */
  @Get('chat/config')
  chatConfig() {
    return this.agent.chatConfig();
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('chat/start')
  startChat(@Body() dto: ChatStartDto) {
    return this.agent.startChat(dto);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('chat/:token/message')
  chatMessage(@Param('token') token: string, @Body() dto: ChatMessageDto) {
    return this.agent.chatMessage(token, dto.message);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('demo-request')
  demoRequest(@Body() dto: DemoRequestDto, @Req() req: any) {
    // Honeypot filled in: answer like a success so the bot moves on, save nothing.
    if (dto.website?.trim())
      return {
        success: true,
        message:
          'Thank you! We’ll call or WhatsApp you within one working day.',
      };
    return this.capture.demoRequest(dto, req?.ip ?? null);
  }
}

/** A partner's own earnings: referral link, referred merchants, commissions, payouts and statements. */
@ApiTags('Admin Partner Portal')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@RequirePermission('partner.portal', 'sales.access', 'sales.manage')
@Controller('api/admin/partner-portal')
export class PartnerPortalController {
  constructor(private readonly partners: SalesPartnersService) {}

  @Get()
  me(@Req() req: any, @Query('month') month?: string) {
    return this.partners.me(salesActor(req.user), month);
  }

  @Get('statement')
  statement(@Req() req: any, @Query('month') month?: string) {
    return this.partners.myStatement(salesActor(req.user), month);
  }
}
