/* eslint-disable prettier/prettier */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
import { salesActor } from './sales-ops.util';
import {
  ActivityDto,
  EmailDto,
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
  constructor(private readonly sales: SalesOpsService) {}

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
