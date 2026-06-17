import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { InventoryService } from './inventory.service';

@Controller('api/inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

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
}
