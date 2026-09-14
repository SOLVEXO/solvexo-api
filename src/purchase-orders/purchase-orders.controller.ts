/* eslint-disable prettier/prettier */
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req,
  UseGuards, UseInterceptors, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PurchaseOrdersService } from './purchase-orders.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

@ApiTags('Purchase Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller', 'admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly service: PurchaseOrdersService) {}

  // ── Suppliers ──────────────────────────────────────────────────────────

  @Post(':storeId/suppliers')
  async createSupplier(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateSupplierDto) {
    const supplier = await this.service.createSupplier(storeId, req.user.userId, dto);
    return { success: true, data: supplier };
  }

  @Get(':storeId/suppliers')
  async listSuppliers(@Req() req: any, @Param('storeId') storeId: string) {
    const suppliers = await this.service.listSuppliers(storeId, req.user.userId);
    return { success: true, data: suppliers };
  }

  @Patch(':storeId/suppliers/:supplierId')
  async updateSupplier(@Req() req: any, @Param('storeId') storeId: string, @Param('supplierId') supplierId: string, @Body() dto: UpdateSupplierDto) {
    const supplier = await this.service.updateSupplier(storeId, req.user.userId, supplierId, dto);
    return { success: true, data: supplier };
  }

  @Delete(':storeId/suppliers/:supplierId')
  async archiveSupplier(@Req() req: any, @Param('storeId') storeId: string, @Param('supplierId') supplierId: string) {
    const supplier = await this.service.archiveSupplier(storeId, req.user.userId, supplierId);
    return { success: true, data: supplier };
  }

  // ── Purchase Orders ────────────────────────────────────────────────────

  @Post(':storeId')
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreatePurchaseOrderDto) {
    const po = await this.service.create(storeId, req.user.userId, dto);
    return { success: true, data: po };
  }

  @Get(':storeId')
  async list(
    @Req() req: any, @Param('storeId') storeId: string,
    @Query('status') status?: string, @Query('search') search?: string,
    @Query('page') page?: string, @Query('limit') limit?: string,
  ) {
    const result = await this.service.list(storeId, req.user.userId, {
      status, search, page: page ? Number(page) : undefined, limit: limit ? Number(limit) : undefined,
    });
    return { success: true, data: result };
  }

  @Get(':storeId/:id')
  async getById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const po = await this.service.getById(storeId, req.user.userId, id);
    return { success: true, data: po };
  }

  @Patch(':storeId/:id')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdatePurchaseOrderDto) {
    const po = await this.service.update(storeId, req.user.userId, id, dto);
    return { success: true, data: po };
  }

  @Post(':storeId/:id/mark-ordered')
  async markAsOrdered(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const po = await this.service.markAsOrdered(storeId, req.user.userId, id);
    return { success: true, data: po };
  }

  @Post(':storeId/:id/cancel')
  async cancel(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const po = await this.service.cancel(storeId, req.user.userId, id);
    return { success: true, data: po };
  }

  @Post(':storeId/:id/close-short')
  async closeShort(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const po = await this.service.closeShort(storeId, req.user.userId, id);
    return { success: true, data: po };
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/:id/receive')
  async receive(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: ReceivePurchaseOrderDto) {
    const result = await this.service.receive(storeId, req.user.userId, id, dto);
    return { success: true, data: result };
  }
}
