/* eslint-disable prettier/prettier */
import { Controller, Post, Get, Patch, Body, Req, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreService } from './store.service';
import { UpdateStoreCustomerDto } from './dto/update-store-customer.dto';

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
  @Patch(':storeId/custom-domain')
  async setCustomDomain(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { domain: string | null }) {
    return this.storeService.setCustomDomain(req.user.userId, storeId, body.domain ?? null);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/white-label')
  async setWhiteLabel(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { enabled: boolean }) {
    return this.storeService.setWhiteLabel(req.user.userId, storeId, !!body.enabled);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('update-store')
  async updateStore(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    const { storeId, ...updateData } = body;
    return this.storeService.updateStore(userId, storeId, updateData);
  }

  // ── Builder APIs ──────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('save-builder-config')
  async saveBuilderConfig(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.storeService.saveBuilderConfig(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('builder-config/:storeId')
  async getBuilderConfig(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.storeService.getBuilderConfig(userId, storeId);
  }

  // ── Public Storefront APIs ────────────────────────────────────────────────

  @Get('public/:slug')
  async getPublicStore(@Param('slug') slug: string) {
    return this.storeService.getPublicStore(slug);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('public/:storeId/products')
  async getPublicStoreProducts(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    return this.storeService.getPublicStoreProducts(storeId, query, req.user?.userId ?? null);
  }

  @Get('public/:storeId/filters')
  async getPublicStoreFilters(@Param('storeId') storeId: string) {
    return this.storeService.getPublicStoreFilters(storeId);
  }

  // ── Follow APIs ───────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post(':storeId/follow')
  async followStore(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.storeService.followStore(userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get(':storeId/follow-status')
  async getFollowStatus(@Req() req: any, @Param('storeId') storeId: string) {
    const { userId } = req.user;
    return this.storeService.getFollowStatus(userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/followers')
  async getStoreFollowers(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const { userId } = req.user;
    return this.storeService.getStoreFollowers(userId, storeId, query);
  }

  // ── Customers (staff-facing) ─────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/customers')
  async getStoreCustomers(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    const { userId } = req.user;
    return this.storeService.getStoreCustomers(userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/customers/:customerId')
  async updateStoreCustomer(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('customerId') customerId: string,
    @Body() dto: UpdateStoreCustomerDto,
  ) {
    const { userId } = req.user;
    return this.storeService.updateStoreCustomer(userId, storeId, customerId, dto, req.ip, req.headers['user-agent']);
  }
}