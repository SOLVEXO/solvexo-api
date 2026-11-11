/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { FbrDiService } from './fbr-di.service';
import { ResolveFbrInvoiceDto, SetFbrTokenDto, UpdateFbrSettingsDto } from './fbr-di.dto';

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
/** The routes that talk to FBR, or change a token / settle an invoice: 10 per minute per caller. */
const SENSITIVE = { default: { limit: 10, ttl: 60_000 } };

/** Super Admin: Solvexo's own FBR invoicing (plan fees). Tokens are server variables, never sent through here. */
@ApiTags('Admin FBR digital invoicing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(pipe)
@Controller('api/admin/fbr-di')
export class AdminFbrDiController {
  constructor(private readonly service: FbrDiService) {}

  @RequirePermission('billing.manage')
  @Get('settings')
  async settings() { return { success: true, data: await this.service.getPlatformSettings() }; }

  @RequirePermission('billing.manage')
  @Put('settings')
  async update(@Body() dto: UpdateFbrSettingsDto, @Req() req: any) { return { success: true, data: await this.service.updatePlatformSettings(dto, req.user.userId) }; }

  /** Sandbox dry run (validateinvoicedata): nothing is filed. */
  @Throttle(SENSITIVE)
  @RequirePermission('billing.manage')
  @Post('test')
  async test(@Req() req: any) { return { success: true, data: await this.service.testPlatform(req.user.userId) }; }

  @RequirePermission('billing.manage')
  @Get('provinces')
  async provinces() {
    const s = this.service.platformToken('sandbox');
    return { success: true, data: await this.service.provinces(s) };
  }

  @RequirePermission('billing.manage')
  @Get('invoices')
  async invoices(@Query('status') status?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return { success: true, data: await this.service.list({ issuer: 'platform', status, page: Number(page), limit: Number(limit) }) };
  }

  @Throttle(SENSITIVE)
  @RequirePermission('billing.manage')
  @Post('invoices/:id/retry')
  async retry(@Param('id') id: string) { return { success: true, data: await this.service.retry(id, { issuer: 'platform' }) }; }

  /** A person settles an invoice whose outcome is unknown (once per invoice, audit-logged). */
  @Throttle(SENSITIVE)
  @RequirePermission('billing.manage')
  @Post('invoices/:id/resolve')
  async resolve(@Param('id') id: string, @Body() dto: ResolveFbrInvoiceDto, @Req() req: any) {
    return { success: true, data: await this.service.resolve(id, { issuer: 'platform' }, dto, { id: req.user.userId, role: 'admin' }) };
  }
}

/** Seller: the store's own FBR invoicing + the FBR numbers of Solvexo's invoices to it. */
@ApiTags('Store FBR digital invoicing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(pipe)
@Controller('api/fbr-di/:storeId')
export class StoreFbrDiController {
  constructor(private readonly service: FbrDiService) {}

  /** Tokens and the on/off switch are the owner's decision, like payment keys. */
  private ownerOnly(req: any) {
    if (req.user?.role !== 'seller') throw new ForbiddenException('Only the store owner can change FBR settings.');
  }

  @RequirePermission('settings.taxes.manage')
  @Get('settings')
  async settings(@Req() req: any, @Param('storeId') storeId: string) {
    return { success: true, data: await this.service.getStoreSettings(storeId, actingSellerId(req.user)) };
  }

  @RequirePermission('settings.taxes.manage')
  @Put('settings')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateFbrSettingsDto) {
    this.ownerOnly(req);
    return { success: true, data: await this.service.updateStoreSettings(storeId, actingSellerId(req.user), dto) };
  }

  @Throttle(SENSITIVE)
  @RequirePermission('settings.taxes.manage')
  @Put('token')
  async setToken(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: SetFbrTokenDto) {
    this.ownerOnly(req);
    return { success: true, data: await this.service.setStoreToken(storeId, actingSellerId(req.user), dto.mode, dto.token) };
  }

  @Throttle(SENSITIVE)
  @RequirePermission('settings.taxes.manage')
  @Delete('token/:mode')
  async deleteToken(@Req() req: any, @Param('storeId') storeId: string, @Param('mode') mode: string) {
    this.ownerOnly(req);
    return { success: true, data: await this.service.deleteStoreToken(storeId, actingSellerId(req.user), mode === 'production' ? 'production' : 'sandbox') };
  }

  @Throttle(SENSITIVE)
  @RequirePermission('settings.taxes.manage')
  @Post('test')
  async test(@Req() req: any, @Param('storeId') storeId: string) {
    this.ownerOnly(req);
    return { success: true, data: await this.service.testStore(storeId, actingSellerId(req.user)) };
  }

  @RequirePermission('settings.taxes.manage')
  @Get('provinces')
  async provinces(@Req() req: any, @Param('storeId') storeId: string) {
    return { success: true, data: await this.service.provincesForStore(storeId, actingSellerId(req.user)) };
  }

  @RequirePermission('settings.taxes.manage')
  @Get('invoices')
  async invoices(@Param('storeId') storeId: string, @Query('status') status?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return { success: true, data: await this.service.list({ issuer: 'store', storeId, status, page: Number(page), limit: Number(limit) }) };
  }

  @Throttle(SENSITIVE)
  @RequirePermission('settings.taxes.manage')
  @Post('invoices/:id/retry')
  async retry(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    this.ownerOnly(req);
    return { success: true, data: await this.service.retry(id, { issuer: 'store', storeId }) };
  }

  /** The owner settles an invoice whose outcome is unknown (once per invoice, audit-logged). */
  @Throttle(SENSITIVE)
  @RequirePermission('settings.taxes.manage')
  @Post('invoices/:id/resolve')
  async resolve(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: ResolveFbrInvoiceDto) {
    this.ownerOnly(req);
    return { success: true, data: await this.service.resolve(id, { issuer: 'store', storeId }, dto, { id: req.user.userId, role: 'seller' }) };
  }

  /** FBR number + QR text of one order, for the printed invoice. */
  @RequirePermission('orders.view')
  @Get('order/:orderId')
  async order(@Param('storeId') storeId: string, @Param('orderId') orderId: string) {
    return { success: true, data: await this.service.orderInvoice(storeId, orderId) };
  }

  /** FBR numbers of Solvexo's plan invoices to this store (Plan & Billing list). */
  @RequirePermission('settings.billing.view')
  @Get('plan-invoices')
  async planInvoices(@Param('storeId') storeId: string) {
    return { success: true, data: await this.service.planInvoicesForStore(storeId) };
  }

  /** The printable Solvexo invoice: Solvexo's legal identity + tax breakdown + the FBR number/QR when filed. Owner only (it carries billing identity). */
  @RequirePermission('settings.billing.view')
  @Get('solvexo-invoice/:invoiceId')
  async solvexoInvoice(@Req() req: any, @Param('storeId') storeId: string, @Param('invoiceId') invoiceId: string) {
    return { success: true, data: await this.service.solvexoInvoiceDocument(storeId, actingSellerId(req.user), invoiceId) };
  }
}
