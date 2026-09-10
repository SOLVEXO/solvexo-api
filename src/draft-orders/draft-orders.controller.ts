/* eslint-disable prettier/prettier */
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req,
  UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
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

  @Get(':storeId/customers/search')
  async searchCustomers(@Req() req: any, @Param('storeId') storeId: string, @Query('q') q: string) {
    const results = await this.draftOrdersService.searchCustomers(storeId, req.user.userId, q);
    return { success: true, data: results };
  }

  @Post(':storeId')
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateDraftOrderDto) {
    const draft = await this.draftOrdersService.create(storeId, req.user.userId, dto);
    return { success: true, data: draft };
  }

  @Get(':storeId')
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    const result = await this.draftOrdersService.list(storeId, req.user.userId, {
      status, page: page ? Number(page) : undefined, limit: limit ? Number(limit) : undefined,
    });
    return { success: true, data: result };
  }

  @Get(':storeId/:id')
  async getById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const draft = await this.draftOrdersService.getById(storeId, req.user.userId, id);
    return { success: true, data: draft };
  }

  @Patch(':storeId/:id')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateDraftOrderDto) {
    const draft = await this.draftOrdersService.update(storeId, req.user.userId, id, dto);
    return { success: true, data: draft };
  }

  @Delete(':storeId/:id')
  async cancel(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const draft = await this.draftOrdersService.cancel(storeId, req.user.userId, id);
    return { success: true, data: draft };
  }

  @Post(':storeId/:id/complete')
  async complete(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    const result = await this.draftOrdersService.complete(storeId, req.user.userId, id);
    return { success: true, data: result };
  }
}
