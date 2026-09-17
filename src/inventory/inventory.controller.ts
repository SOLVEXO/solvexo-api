import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { InventoryService } from './inventory.service';

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
  @Get('low-stock-summary/:storeId')
  async getLowStockSummary(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.inventoryService.getLowStockSummary(userId, storeId);
  }
}
