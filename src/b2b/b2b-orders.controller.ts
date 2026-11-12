/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Header, Param, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { B2BOrdersService } from './b2b-orders.service';
import { EntitlementsService } from '../platform-plans/entitlements.service';

/** Seller wholesale receivables. Permissions: b2b.view (read) / b2b.manage (record or void payments). */
@ApiTags('B2B orders (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/b2b/:storeId')
export class B2BOrdersController {
  constructor(private readonly svc: B2BOrdersService, private readonly db: DatabaseService, private readonly entitlements: EntitlementsService) {}
  private async own(req: any, storeId: string, write = false) {
    const sellerId = actingSellerId(req.user);
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, sellerId);
    if (write) await this.entitlements.assertFeatureAllowed(storeId, 'b2bWholesaleAllowed', 'Wholesale (B2B)');
    return { sellerId, actor: { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) } };
  }

  @Get('orders') @RequirePermission('b2b.view')
  async orders(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.svc.listOrders(s, q); }

  @Post('orders/:orderId/payments') @RequirePermission('b2b.manage')
  async record(@Req() req: any, @Param('storeId') s: string, @Param('orderId') id: string, @Body() b: any) { const o = await this.own(req, s); return this.svc.recordPayment(s, o.sellerId, o.actor, id, b); }

  @Post('orders/:orderId/payments/:paymentId/void') @RequirePermission('b2b.manage')
  async voidPayment(@Req() req: any, @Param('storeId') s: string, @Param('orderId') id: string, @Param('paymentId') pid: string) { const o = await this.own(req, s); return this.svc.voidPayment(s, o.actor, id, pid); }

  @Get('reports/outstanding') @RequirePermission('b2b.view')
  async outstanding(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.outstandingReport(s); }

  @Get('reports/outstanding.csv') @RequirePermission('b2b.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="outstanding-balances.csv"')
  async outstandingCsv(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.outstandingReport(s, { csv: true }); }
}
