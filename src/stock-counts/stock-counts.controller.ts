/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { StockCountsService } from './stock-counts.service';

@ApiTags('Stock Counts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller', 'admin')
@Controller('api/stock-counts')
export class StockCountsController {
  constructor(private readonly service: StockCountsService) {}

  @Post(':storeId/start')
  async start(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { locationId?: string }) {
    const count = await this.service.start(storeId, req.user.userId, body?.locationId);
    return { success: true, data: count };
  }

  @Get(':storeId')
  async list(@Req() req: any, @Param('storeId') storeId: string) {
    const items = await this.service.list(storeId, req.user.userId);
    return { success: true, data: items };
  }

  @Get(':storeId/:id')
  async getById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const count = await this.service.getById(storeId, req.user.userId, id);
    return { success: true, data: count };
  }

  @Post(':storeId/:id/items/:itemId')
  async submitCount(
    @Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Param('itemId') itemId: string,
    @Body() body: { countedQty: number },
  ) {
    const count = await this.service.submitCount(storeId, req.user.userId, id, itemId, body.countedQty);
    return { success: true, data: count };
  }

  @Post(':storeId/:id/cancel')
  async cancel(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const count = await this.service.cancel(storeId, req.user.userId, id);
    return { success: true, data: count };
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/:id/finish')
  async finish(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const result = await this.service.finish(storeId, req.user.userId, id);
    return { success: true, data: result };
  }
}
