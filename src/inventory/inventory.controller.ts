import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { InventoryService } from './inventory.service';
import type { StockAdjustmentReason } from './schemas/stock-adjustment.schema';

@Controller('api/inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('export/:storeId')
  async exportInventoryCsv(@Req() req: any, @Res() res: Response, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    const csv = await this.inventoryService.exportInventoryCsv(userId, storeId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
    res.send(csv);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('getStoreInventory/:storeId')
  async getStoreInventory(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const { userId } = req.user;
    return this.inventoryService.getStoreInventory(userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Post(':storeId/import-stock-csv')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async importStockCsv(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: Express.Multer.File) {
    const { userId } = req.user;
    if (!file) throw new BadRequestException('No CSV file uploaded');
    return this.inventoryService.importStockCsv(userId, storeId, file.buffer.toString('utf-8'));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get('low-stock-summary/:storeId')
  async getLowStockSummary(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.inventoryService.getLowStockSummary(userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get(':storeId/valuation')
  async getValuation(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.inventoryService.getValuation(userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get(':storeId/reorder-suggestions')
  async getReorderSuggestions(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.inventoryService.getReorderSuggestions(userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get(':storeId/stock-lines')
  async getStockLines(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    const { userId } = req.user;
    return this.inventoryService.getStockLines(userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Patch(':storeId/variant/:variantId/adjust')
  async adjustStock(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('variantId') variantId: string,
    @Body() body: { delta: number; reason: StockAdjustmentReason; note?: string; locationId?: string },
  ) {
    const { userId } = req.user;
    return this.inventoryService.adjustStock(
      userId, storeId, variantId, body.delta, body.reason, body.note, body.locationId,
    );
  }

  // ── Multi-location (only meaningful once a store has 2+ real
  // StoreLocations — location CRUD itself already exists at
  // `api/pos/locations/:storeId`, reused as-is, not duplicated here). ────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get(':storeId/locations')
  async listActiveLocations(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.inventoryService.listActiveLocations(userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get(':storeId/variant/:variantId/locations')
  async getVariantLocations(@Req() req: any, @Param('storeId') storeId: string, @Param('variantId') variantId: string) {
    const { userId } = req.user;
    return this.inventoryService.getVariantLocations(userId, storeId, variantId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Post(':storeId/variant/:variantId/transfer/ship')
  async shipTransfer(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('variantId') variantId: string,
    @Body() body: { fromLocationId: string; toLocationId: string; quantity: number; note?: string },
  ) {
    const { userId } = req.user;
    return this.inventoryService.shipTransfer(
      userId, storeId, variantId, body.fromLocationId, body.toLocationId, body.quantity, body.note,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/transfer/:transferId/receive')
  async receiveTransfer(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('transferId') transferId: string,
    @Body() body: { receivedQty: number },
  ) {
    const { userId } = req.user;
    return this.inventoryService.receiveTransfer(userId, storeId, transferId, body.receivedQty);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Post(':storeId/transfer/:transferId/cancel')
  async cancelTransfer(@Req() req: any, @Param('storeId') storeId: string, @Param('transferId') transferId: string) {
    const { userId } = req.user;
    return this.inventoryService.cancelTransfer(userId, storeId, transferId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get(':storeId/transfers')
  async listTransfers(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    const { userId } = req.user;
    return this.inventoryService.listTransfers(userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Get(':storeId/variant/:variantId/history')
  async getStockHistory(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('variantId') variantId: string,
    @Query() query: any,
  ) {
    const { userId } = req.user;
    return this.inventoryService.getStockHistory(
      userId,
      storeId,
      variantId,
      parseInt(query.page) || 1,
      parseInt(query.limit) || 20,
    );
  }
}
