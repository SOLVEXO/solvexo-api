/* eslint-disable prettier/prettier */
import { BadRequestException, Controller, Get, Param, Patch, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminUsersService } from './admin-users.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { StoreCustomersQueryDto } from './dto/store-customers-query.dto';
import { StoreService } from '../store/store.service';

@ApiTags('Admin Users & Sellers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/users')
export class AdminUsersController {
  constructor(
    private readonly adminUsersService: AdminUsersService,
    private readonly storeService: StoreService,
  ) {}

  private meta(req: any) {
    return { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  private validateRole(role: string): 'buyer' | 'seller' {
    if (role !== 'buyer' && role !== 'seller') {
      throw new BadRequestException('role must be "buyer" or "seller"');
    }
    return role;
  }

  @Get('stats')
  getStats() {
    return this.adminUsersService.getStats();
  }

  @Get()
  list(@Query() query: AdminUsersQueryDto) {
    return this.adminUsersService.list(query);
  }

  // ── Store-scoped routes — declared BEFORE the generic `:role/:id` routes
  // below so their literal `stores` segment always wins the match (Nest/
  // Express resolves routes in registration order; `:role` would otherwise
  // happily swallow "stores" as a value). This is where a store's buyers
  // live — see AdminUsersService's class doc comment for why buyers aren't
  // on the top-level list. ──

  @Get('stores/:storeId/customers')
  getStoreCustomers(@Param('storeId') storeId: string, @Query() query: StoreCustomersQueryDto) {
    return this.storeService.getStoreCustomersAdmin(storeId, query);
  }

  @Patch('stores/:storeId/customers/:buyerId/block')
  blockStoreCustomer(@Req() req: any, @Param('storeId') storeId: string, @Param('buyerId') buyerId: string) {
    return this.storeService.setCustomerBlockedAdmin(storeId, buyerId, true, this.meta(req));
  }

  @Patch('stores/:storeId/customers/:buyerId/unblock')
  unblockStoreCustomer(@Req() req: any, @Param('storeId') storeId: string, @Param('buyerId') buyerId: string) {
    return this.storeService.setCustomerBlockedAdmin(storeId, buyerId, false, this.meta(req));
  }

  @Patch('stores/:storeId/suspend')
  suspendStore(@Req() req: any, @Param('storeId') storeId: string) {
    return this.adminUsersService.suspendStore(storeId, this.meta(req));
  }

  @Patch('stores/:storeId/unsuspend')
  unsuspendStore(@Req() req: any, @Param('storeId') storeId: string) {
    return this.adminUsersService.unsuspendStore(storeId, this.meta(req));
  }

  // ── Generic account routes — still cover both roles: 'seller' for the
  // whole-account view/suspend from this page's own list, and 'buyer' for
  // the platform-wide ban reachable from a store's customer list above. ──

  @Get(':role/:id')
  getById(@Param('role') role: string, @Param('id') id: string) {
    return this.adminUsersService.getById(this.validateRole(role), id);
  }

  @Patch(':role/:id/suspend')
  suspend(@Req() req: any, @Param('role') role: string, @Param('id') id: string) {
    return this.adminUsersService.suspend(this.validateRole(role), id, this.meta(req));
  }

  @Patch(':role/:id/unsuspend')
  unsuspend(@Req() req: any, @Param('role') role: string, @Param('id') id: string) {
    return this.adminUsersService.unsuspend(this.validateRole(role), id, this.meta(req));
  }
}
