/* eslint-disable prettier/prettier */
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req,
  UseGuards, UseInterceptors, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PurchaseOrdersService } from './purchase-orders.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

// See InventoryController's identical helper doc comment — a staff JWT
// carries its OWNING seller's id as `sellerId`, which every handler below
// passes into PurchaseOrdersService's existing `sellerId`-scoped methods.
function actingSellerId(user: any): string {
  return user.role === 'staff' ? user.sellerId : user.userId;
}

@ApiTags('Purchase Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'admin', 'staff')
@RequirePermission('purchase_orders.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly service: PurchaseOrdersService) {}

  // ── Suppliers ──────────────────────────────────────────────────────────

  @Post(':storeId/suppliers')
  async createSupplier(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateSupplierDto) {
    const supplier = await this.service.createSupplier(storeId, actingSellerId(req.user), dto);
    return { success: true, data: supplier };
  }

  @Get(':storeId/suppliers')
  async listSuppliers(@Req() req: any, @Param('storeId') storeId: string) {
    const suppliers = await this.service.listSuppliers(storeId, actingSellerId(req.user));
    return { success: true, data: suppliers };
  }

  @Patch(':storeId/suppliers/:supplierId')
  async updateSupplier(@Req() req: any, @Param('storeId') storeId: string, @Param('supplierId') supplierId: string, @Body() dto: UpdateSupplierDto) {
    const supplier = await this.service.updateSupplier(storeId, actingSellerId(req.user), supplierId, dto);
    return { success: true, data: supplier };
  }

  @Delete(':storeId/suppliers/:supplierId')
  async archiveSupplier(@Req() req: any, @Param('storeId') storeId: string, @Param('supplierId') supplierId: string) {
    const supplier = await this.service.archiveSupplier(storeId, actingSellerId(req.user), supplierId);
    return { success: true, data: supplier };
  }

  // ── Purchase Orders ────────────────────────────────────────────────────

  @Post(':storeId')
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreatePurchaseOrderDto) {
    const po = await this.service.create(storeId, actingSellerId(req.user), dto);
    return { success: true, data: po };
  }

  @Get(':storeId')
  async list(
    @Req() req: any, @Param('storeId') storeId: string,
    @Query('status') status?: string, @Query('search') search?: string,
    @Query('page') page?: string, @Query('limit') limit?: string,
  ) {
    const result = await this.service.list(storeId, actingSellerId(req.user), {
      status, search, page: page ? Number(page) : undefined, limit: limit ? Number(limit) : undefined,
    });
    return { success: true, data: result };
  }

  @Get(':storeId/:id')
  async getById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const po = await this.service.getById(storeId, actingSellerId(req.user), id);
    return { success: true, data: po };
  }

  @Patch(':storeId/:id')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdatePurchaseOrderDto) {
    const po = await this.service.update(storeId, actingSellerId(req.user), id, dto);
    return { success: true, data: po };
  }

  @Post(':storeId/:id/mark-ordered')
  async markAsOrdered(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const po = await this.service.markAsOrdered(storeId, actingSellerId(req.user), id);
    return { success: true, data: po };
  }

  @Post(':storeId/:id/cancel')
  async cancel(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const po = await this.service.cancel(storeId, actingSellerId(req.user), id);
    return { success: true, data: po };
  }

  @Post(':storeId/:id/close-short')
  async closeShort(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const po = await this.service.closeShort(storeId, actingSellerId(req.user), id);
    return { success: true, data: po };
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/:id/receive')
  async receive(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: ReceivePurchaseOrderDto) {
    const result = await this.service.receive(storeId, actingSellerId(req.user), id, dto);
    return { success: true, data: result };
  }
}
