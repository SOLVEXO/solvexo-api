import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { InventoryService } from './inventory.service';
import type { StockAdjustmentReason } from './schemas/stock-adjustment.schema';

// A staff member's JWT carries their OWNING seller's id as `sellerId` (see
// JwtStrategy's doc comment) — every handler below passes THIS into
// InventoryService's existing `sellerId`-scoped methods unchanged, so a
// store-ownership check written for a seller's own JWT also correctly
// passes for a staff caller acting on that same store. A seller/admin
// caller's own `userId` IS already that value.
function actingSellerId(user: any): string {
  return user.role === 'staff' ? user.sellerId : user.userId;
}

@Controller('api/inventory')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'admin', 'staff')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @RequirePermission('inventory.view')
  @Get('export/:storeId')
  async exportInventoryCsv(@Req() req: any, @Res() res: Response, @Param('storeId') storeId: string) {
    const csv = await this.inventoryService.exportInventoryCsv(actingSellerId(req.user), storeId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
    res.send(csv);
  }

  @RequirePermission('inventory.view')
  @Get('getStoreInventory/:storeId')
  async getStoreInventory(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.inventoryService.getStoreInventory(actingSellerId(req.user), storeId, query);
  }

  @RequirePermission('inventory.adjust')
  @Post(':storeId/import-stock-csv')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async importStockCsv(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No CSV file uploaded');
    return this.inventoryService.importStockCsv(actingSellerId(req.user), storeId, file.buffer.toString('utf-8'));
  }

  @RequirePermission('inventory.view')
  @Get('low-stock-summary/:storeId')
  async getLowStockSummary(@Req() req: any, @Param('storeId') storeId: string) {
    return this.inventoryService.getLowStockSummary(actingSellerId(req.user), storeId);
  }

  @RequirePermission('inventory.view')
  @Get(':storeId/valuation')
  async getValuation(@Req() req: any, @Param('storeId') storeId: string) {
    return this.inventoryService.getValuation(actingSellerId(req.user), storeId);
  }

  @RequirePermission('inventory.view')
  @Get(':storeId/reorder-suggestions')
  async getReorderSuggestions(@Req() req: any, @Param('storeId') storeId: string) {
    return this.inventoryService.getReorderSuggestions(actingSellerId(req.user), storeId);
  }

  @RequirePermission('inventory.view')
  @Get(':storeId/stock-lines')
  async getStockLines(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.inventoryService.getStockLines(actingSellerId(req.user), storeId, query);
  }

  @RequirePermission('inventory.adjust')
  @Patch(':storeId/variant/:variantId/adjust')
  async adjustStock(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('variantId') variantId: string,
    @Body() body: { delta: number; reason: StockAdjustmentReason; note?: string; locationId?: string },
  ) {
    const { role, userId, permissions } = req.user;
    return this.inventoryService.adjustStock(
      actingSellerId(req.user), storeId, variantId, body.delta, body.reason, body.note, body.locationId,
      { actorId: userId, actorRole: role, actorPermissions: permissions ?? null },
    );
  }

  // ── Approvals queue (staff adjustments requiring sign-off) ─────────────

  @RequirePermission('inventory.approve')
  @Get(':storeId/approvals')
  async listApprovals(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string) {
    return this.inventoryService.listApprovals(actingSellerId(req.user), storeId, status);
  }

  @RequirePermission('inventory.approve')
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/approvals/:approvalId/approve')
  async approveRequest(@Req() req: any, @Param('storeId') storeId: string, @Param('approvalId') approvalId: string) {
    const { userId, role } = req.user;
    return this.inventoryService.approveRequest(actingSellerId(req.user), storeId, approvalId, userId, role);
  }

  @RequirePermission('inventory.approve')
  @Post(':storeId/approvals/:approvalId/reject')
  async rejectRequest(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: { reason?: string },
  ) {
    const { userId, role } = req.user;
    return this.inventoryService.rejectRequest(actingSellerId(req.user), storeId, approvalId, userId, role, body.reason);
  }

  // ── Multi-location (only meaningful once a store has 2+ real
  // StoreLocations — location CRUD itself already exists at
  // `api/pos/locations/:storeId`, reused as-is, not duplicated here). ────

  @RequirePermission('inventory.view')
  @Get(':storeId/locations')
  async listActiveLocations(@Req() req: any, @Param('storeId') storeId: string) {
    return this.inventoryService.listActiveLocations(actingSellerId(req.user), storeId);
  }

  @RequirePermission('inventory.view')
  @Get(':storeId/variant/:variantId/locations')
  async getVariantLocations(@Req() req: any, @Param('storeId') storeId: string, @Param('variantId') variantId: string) {
    return this.inventoryService.getVariantLocations(actingSellerId(req.user), storeId, variantId);
  }

  // ── Bins (bin/shelf-level granularity within one location) ─────────────

  @RequirePermission('inventory.view')
  @Get(':storeId/locations/:locationId/bins')
  async listBins(@Req() req: any, @Param('storeId') storeId: string, @Param('locationId') locationId: string) {
    return this.inventoryService.listBins(actingSellerId(req.user), storeId, locationId);
  }

  @RequirePermission('inventory.adjust')
  @Post(':storeId/locations/:locationId/bins')
  async createBin(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('locationId') locationId: string,
    @Body() body: { code: string; zone?: string; aisle?: string; shelf?: string },
  ) {
    return this.inventoryService.createBin(actingSellerId(req.user), storeId, locationId, body);
  }

  @RequirePermission('inventory.adjust')
  @Delete(':storeId/bins/:binId')
  async deleteBin(@Req() req: any, @Param('storeId') storeId: string, @Param('binId') binId: string) {
    return this.inventoryService.deleteBin(actingSellerId(req.user), storeId, binId);
  }

  @RequirePermission('inventory.transfer')
  @Post(':storeId/variant/:variantId/transfer/ship')
  async shipTransfer(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('variantId') variantId: string,
    @Body() body: { fromLocationId: string; toLocationId: string; quantity: number; note?: string },
  ) {
    return this.inventoryService.shipTransfer(
      actingSellerId(req.user), storeId, variantId, body.fromLocationId, body.toLocationId, body.quantity, body.note,
    );
  }

  @RequirePermission('inventory.transfer')
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/transfer/:transferId/receive')
  async receiveTransfer(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('transferId') transferId: string,
    @Body() body: { receivedQty: number; binId?: string },
  ) {
    return this.inventoryService.receiveTransfer(actingSellerId(req.user), storeId, transferId, body.receivedQty, body.binId);
  }

  @RequirePermission('inventory.transfer')
  @Post(':storeId/transfer/:transferId/cancel')
  async cancelTransfer(@Req() req: any, @Param('storeId') storeId: string, @Param('transferId') transferId: string) {
    return this.inventoryService.cancelTransfer(actingSellerId(req.user), storeId, transferId);
  }

  @RequirePermission('inventory.view')
  @Get(':storeId/transfers')
  async listTransfers(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.inventoryService.listTransfers(actingSellerId(req.user), storeId, query);
  }

  @RequirePermission('inventory.view')
  @Get(':storeId/variant/:variantId/history')
  async getStockHistory(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('variantId') variantId: string,
    @Query() query: any,
  ) {
    return this.inventoryService.getStockHistory(
      actingSellerId(req.user), storeId, variantId, parseInt(query.page) || 1, parseInt(query.limit) || 20,
    );
  }
}
