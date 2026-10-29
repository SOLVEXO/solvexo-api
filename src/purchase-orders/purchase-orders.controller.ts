/* eslint-disable prettier/prettier */
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res,
  UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv } from '../common/bulk-import/bulk-import.util';
import { SUPPLIER_IMPORT_COLUMNS } from './supplier-bulk-import';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PurchaseOrdersService } from './purchase-orders.service';
import { SupplierReturnsService, CreateSupplierReturnDto } from './supplier-returns.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { MarkOrderedPurchaseOrderDto } from './dto/mark-ordered-purchase-order.dto';
import { actingSellerId } from '../common/acting-seller-id.util';

@ApiTags('Purchase Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'admin', 'staff')
@RequirePermission('purchase_orders.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly service: PurchaseOrdersService, private readonly returnsService: SupplierReturnsService) {}

  // ── Supplier returns (declared before the generic ":storeId/:id" routes so "returns" is not read as a PO id) ──

  @Post(':storeId/returns')
  async createSupplierReturn(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateSupplierReturnDto) {
    const key = req.headers?.['idempotency-key'];
    if (!dto.requestId && typeof key === 'string' && key) dto.requestId = key.slice(0, 100);
    return this.returnsService.create(storeId, actingSellerId(req.user), dto, req.user.userId, { role: req.user.role, permissions: req.user.permissions ?? null });
  }

  @Get(':storeId/returns/export')
  async exportSupplierReturns(@Req() req: any, @Res() res: any, @Param('storeId') storeId: string) {
    const csv = await this.returnsService.exportCsv(storeId, actingSellerId(req.user));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="supplier-returns.csv"');
    res.send(csv);
  }

  @Get(':storeId/returns')
  async listSupplierReturns(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.returnsService.list(storeId, actingSellerId(req.user), query);
  }

  @Post(':storeId/returns/:returnId/credit-received')
  async markReturnCredit(@Req() req: any, @Param('storeId') storeId: string, @Param('returnId') returnId: string) {
    return this.returnsService.markCreditReceived(storeId, actingSellerId(req.user), returnId);
  }

  // ── Suppliers ──────────────────────────────────────────────────────────

  @Post(':storeId/suppliers')
  async createSupplier(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateSupplierDto) {
    const supplier = await this.service.createSupplier(storeId, actingSellerId(req.user), dto);
    return { success: true, data: supplier };
  }

  @Get(':storeId/suppliers/import-template')
  async suppliersImportTemplate() {
    return buildTemplatePayload('suppliers-import-template.csv', SUPPLIER_IMPORT_COLUMNS);
  }

  @Post(':storeId/suppliers/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async importSuppliers(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any) {
    return this.service.importSuppliers(storeId, actingSellerId(req.user), readUploadedCsv(file));
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

  /** The PO rendered as a branded, downloadable PDF — the seller's own logo
   *  and colours (Settings → Order documents), streamed on demand the same
   *  way the finance tax-report PDF is. */
  @Get(':storeId/:id/pdf')
  async downloadPdf(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Res() res: any) {
    const { buffer, filename } = await this.service.buildPdf(storeId, actingSellerId(req.user), id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /** Emails the PO (with that same PDF attached) to the supplier's own address. */
  @Post(':storeId/:id/send-to-supplier')
  async sendToSupplier(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const result = await this.service.sendToSupplier(storeId, actingSellerId(req.user), id);
    return { success: true, data: result };
  }

  @Patch(':storeId/:id')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdatePurchaseOrderDto) {
    const po = await this.service.update(storeId, actingSellerId(req.user), id, dto);
    return { success: true, data: po };
  }

  @Post(':storeId/:id/mark-ordered')
  async markAsOrdered(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: MarkOrderedPurchaseOrderDto) {
    const po = await this.service.markAsOrdered(storeId, actingSellerId(req.user), id, dto.emailSupplier === true);
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

  // Receiving stock is a warehouse task: a role with just 'Receive purchase orders' must be able to do it.
  @RequirePermission('purchase_orders.manage', 'inventory.receive')
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/:id/receive')
  async receive(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: ReceivePurchaseOrderDto) {
    // DB-backed duplicate protection: the client's Idempotency-Key doubles as the receipt's requestId
    const key = req.headers?.['idempotency-key'];
    if (!dto.requestId && typeof key === 'string' && key) dto.requestId = key.slice(0, 100);
    const result = await this.service.receive(storeId, actingSellerId(req.user), id, dto);
    return { success: true, data: result };
  }
}
