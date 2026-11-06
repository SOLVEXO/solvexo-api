/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Header, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { KhataService } from './khata.service';

/** Seller customer ledger (khata). Permissions: khata.view (read) / khata.manage (post, reverse, limits). */
@ApiTags('Khata (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/khata/:storeId')
export class KhataController {
  constructor(private readonly svc: KhataService, private readonly db: DatabaseService) {}
  private async own(req: any, storeId: string) {
    const store: any = await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
    return { store, actor: { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) } };
  }

  @Get('accounts') @RequirePermission('khata.view')
  async list(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.svc.listAccounts(s, q); }

  @Post('accounts') @RequirePermission('khata.manage')
  async create(@Req() req: any, @Param('storeId') s: string, @Body() b: any) {
    const { store } = await this.own(req, s);
    return this.svc.ensureAccount(s, { customerId: typeof b?.customerId === 'string' ? b.customerId : null, name: b?.name, phone: b?.phone, creditLimit: b?.creditLimit, currency: String(store.baseCurrency ?? store.currency ?? 'USD') });
  }

  @Get('report/aging') @RequirePermission('khata.view')
  async agingReport(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.agingReport(s); }

  @Get('accounts/:accountId') @RequirePermission('khata.view')
  async one(@Req() req: any, @Param('storeId') s: string, @Param('accountId') id: string) { await this.own(req, s); return this.svc.getAccount(s, id); }

  @Get('accounts/:accountId/entries') @RequirePermission('khata.view')
  async entries(@Req() req: any, @Param('storeId') s: string, @Param('accountId') id: string, @Query() q: any) { await this.own(req, s); return this.svc.listEntries(s, id, q); }

  @Get('accounts/:accountId/aging') @RequirePermission('khata.view')
  async aging(@Req() req: any, @Param('storeId') s: string, @Param('accountId') id: string) { await this.own(req, s); return this.svc.aging(s, id); }

  @Get('accounts/:accountId/statement') @RequirePermission('khata.view')
  async statement(@Req() req: any, @Param('storeId') s: string, @Param('accountId') id: string, @Query('from') from?: string, @Query('to') to?: string) { await this.own(req, s); return this.svc.statement(s, id, from, to); }

  @Get('accounts/:accountId/statement.csv') @RequirePermission('khata.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="khata-statement.csv"')
  async statementCsv(@Req() req: any, @Param('storeId') s: string, @Param('accountId') id: string, @Query('from') from?: string, @Query('to') to?: string) { await this.own(req, s); return this.svc.statementCsv(s, id, from, to); }

  @Post('accounts/:accountId/entries') @RequirePermission('khata.manage')
  async post(@Req() req: any, @Param('storeId') s: string, @Param('accountId') id: string, @Body() b: any) {
    const { actor } = await this.own(req, s);
    // Only the fields a person may enter by hand; source/sourceKey/reversal links are set by the server.
    return this.svc.post(s, id, { type: b?.type, amount: b?.amount, method: b?.method, reference: b?.reference, note: b?.note, dueDate: b?.dueDate, entryDate: b?.entryDate, orderId: typeof b?.orderId === 'string' ? b.orderId : null, source: 'manual' }, actor);
  }

  @Post('entries/:entryId/reverse') @RequirePermission('khata.manage')
  async reverse(@Req() req: any, @Param('storeId') s: string, @Param('entryId') id: string, @Body() b: any) { const { actor } = await this.own(req, s); return this.svc.reverse(s, id, b?.note, actor); }

  @Patch('accounts/:accountId/limit') @RequirePermission('khata.manage')
  async limit(@Req() req: any, @Param('storeId') s: string, @Param('accountId') id: string, @Body() b: any) { const { actor } = await this.own(req, s); return this.svc.setLimit(s, id, b?.creditLimit, actor); }
}
