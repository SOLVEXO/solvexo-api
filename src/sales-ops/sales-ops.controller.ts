/* eslint-disable prettier/prettier */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { SalesOpsService } from './sales-ops.service';
import { SalesCaptureService } from './sales-capture.service';
import { SalesGrowthService } from './sales-growth.service';
import { salesActor } from './sales-ops.util';
import {
  ActivityDto,
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
} from './sales-ops.dto';

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
  ) {}

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
  @Get('templates') templates() {
    return this.sales.listTemplates();
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
  constructor(private readonly capture: SalesCaptureService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('demo-request')
  demoRequest(@Body() dto: DemoRequestDto) {
    // Honeypot filled in: answer like a success so the bot moves on, save nothing.
    if (dto.website?.trim())
      return {
        success: true,
        message:
          'Thank you! We’ll call or WhatsApp you within one working day.',
      };
    return this.capture.demoRequest(dto);
  }
}
