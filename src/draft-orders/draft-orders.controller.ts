/* eslint-disable prettier/prettier */
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req,
  UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { DraftOrdersService } from './draft-orders.service';
import { CreateDraftOrderDto } from './dto/create-draft-order.dto';
import { UpdateDraftOrderDto } from './dto/update-draft-order.dto';

@ApiTags('Draft Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/draft-orders')
export class DraftOrdersController {
  constructor(private readonly draftOrdersService: DraftOrdersService) {}

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.manage')
  @Get(':storeId/customers/search')
  async searchCustomers(@Req() req: any, @Param('storeId') storeId: string, @Query('q') q: string) {
    const results = await this.draftOrdersService.searchCustomers(storeId, actingSellerId(req.user), q);
    return { success: true, data: results };
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.manage')
  @Post(':storeId')
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateDraftOrderDto) {
    const draft = await this.draftOrdersService.create(storeId, actingSellerId(req.user), dto);
    return { success: true, data: draft };
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.view')
  @Get(':storeId')
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    const result = await this.draftOrdersService.list(storeId, actingSellerId(req.user), {
      status, page: page ? Number(page) : undefined, limit: limit ? Number(limit) : undefined,
    });
    return { success: true, data: result };
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.view')
  @Get(':storeId/:id')
  async getById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const draft = await this.draftOrdersService.getById(storeId, actingSellerId(req.user), id);
    return { success: true, data: draft };
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.manage')
  @Patch(':storeId/:id')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateDraftOrderDto) {
    const draft = await this.draftOrdersService.update(storeId, actingSellerId(req.user), id, dto);
    return { success: true, data: draft };
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.manage')
  @Delete(':storeId/:id')
  async cancel(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const draft = await this.draftOrdersService.cancel(storeId, actingSellerId(req.user), id);
    return { success: true, data: draft };
  }

  // Real hard-delete (isDelete soft-delete convention) — distinct from
  // `cancel` above (kept on its existing DELETE :storeId/:id route for
  // backward compatibility). Restricted to a never-completed draft — see
  // DraftOrdersService.deleteDraft's own doc comment.
  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.manage')
  @Delete(':storeId/:id/permanent')
  async deleteDraft(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.draftOrdersService.deleteDraft(storeId, actingSellerId(req.user), id);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.manage')
  @Post(':storeId/:id/duplicate')
  async duplicate(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const draft = await this.draftOrdersService.duplicate(storeId, actingSellerId(req.user), id);
    return { success: true, data: draft };
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.manage')
  @Post(':storeId/:id/send-invoice')
  async sendInvoice(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.draftOrdersService.sendInvoice(storeId, actingSellerId(req.user), id);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.mark_paid')
  @Post(':storeId/:id/mark-paid')
  async markPaid(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const draft = await this.draftOrdersService.markAsPaid(storeId, actingSellerId(req.user), id);
    return { success: true, data: draft };
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('draft_orders.manage')
  @Post(':storeId/:id/complete')
  async complete(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const result = await this.draftOrdersService.complete(storeId, actingSellerId(req.user), id);
    return { success: true, data: result };
  }
}
