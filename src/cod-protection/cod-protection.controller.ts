/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Put, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { CodProtectionService } from './cod-protection.service';
import { CodConfirmationService } from './cod-confirmation.service';

/** Seller: COD protection rules and manual confirmation. Permissions: settings.payments.manage (rules), orders.edit (confirm an order). */
@ApiTags('COD protection (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/cod-protection/:storeId')
export class CodProtectionController {
  constructor(private readonly svc: CodProtectionService, private readonly confirmation: CodConfirmationService, private readonly db: DatabaseService) {}
  private async own(req: any, storeId: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
    return { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) };
  }

  @Get('settings') @RequirePermission('settings.payments.manage')
  async settings(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.getSettings(s); }

  @Put('settings') @RequirePermission('settings.payments.manage')
  async update(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { return this.svc.updateSettings(s, await this.own(req, s), b); }

  /** Send the confirmation message again (a new link; older links stop working). Only while the order waits. */
  @Post('orders/:orderId/resend-confirmation') @RequirePermission('orders.edit')
  async resend(@Req() req: any, @Param('storeId') s: string, @Param('orderId') id: string) {
    await this.own(req, s);
    await this.svc.assertOrderOfStore(s, id);
    return this.confirmation.send(id);
  }

  @Post('orders/:orderId/confirm') @RequirePermission('orders.edit')
  async confirm(@Req() req: any, @Param('storeId') s: string, @Param('orderId') id: string, @Body() b: any) { return this.svc.manualConfirm(s, await this.own(req, s), id, b?.note); }
}
