/* eslint-disable prettier/prettier */
import { Controller, Post, Get, Body, Req, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreService } from './store.service';

@Controller('api/store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('create-store')
  async createStore(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.storeService.createStore(userId, body);
  }

  // seller ke saare stores
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('my-stores')
  async getMyStores(@Req() req: any) {
    const { userId } = req.user;
    return this.storeService.getMyStores(userId);
  }

  @Get('getStoreById/:storeId')
  async getStoreById(@Param('storeId') storeId: string) {
    return this.storeService.getStoreById(storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('update-store')
  async updateStore(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    const { storeId, ...updateData } = body;
    return this.storeService.updateStore(userId, storeId, updateData);
  }
}