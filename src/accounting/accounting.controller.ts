/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { isoExponent } from '../common/money-minor.util';
import { DatabaseService } from '../database/databaseservice';
import { AccountingService } from './accounting.service';
import { AccountingSyncService } from './accounting-sync.service';

/** The store's books (Accounting Plan, Phase 1). Permissions: accounting.view (read) / accounting.manage (setup, entries, sync). */
@ApiTags('Accounting (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/accounting/:storeId')
export class AccountingController {
  constructor(private readonly svc: AccountingService, private readonly sync: AccountingSyncService, private readonly db: DatabaseService) {}

  private async own(req: any, storeId: string) {
    const store: any = await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
    return { store, actor: { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) } };
  }

  @Get('settings') @RequirePermission('accounting.view')
  async settings(@Req() req: any, @Param('storeId') s: string) {
    const { store } = await this.own(req, s);
    const settings = await this.svc.settings(s);
    const currency = settings?.baseCurrency ?? String(store.baseCurrency || 'PKR').toUpperCase();
    return { enabled: !!settings?.enabled, settings, currency, exponent: isoExponent(currency) };
  }

  @Post('setup') @RequirePermission('accounting.manage')
  async setup(@Req() req: any, @Param('storeId') s: string, @Body() b: any) {
    const { store, actor } = await this.own(req, s);
    const settings = await this.svc.setup(s, store, b, actor);
    void this.sync.syncStore(s).catch(() => undefined); // first postings start right away
    return settings;
  }

  @Post('sync') @RequirePermission('accounting.manage')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  async runSync(@Req() req: any, @Param('storeId') s: string) {
    await this.own(req, s); await this.svc.requireEnabled(s);
    const r = await this.sync.syncStore(s);
    return r === 'busy' ? { status: 'busy' } : { status: 'done', ...r };
  }

  @Post('check') @RequirePermission('accounting.manage')
  async check(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); await this.svc.requireEnabled(s); return this.svc.check(s); }

  @Get('accounts') @RequirePermission('accounting.view')
  async accounts(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.listAccounts(s); }

  @Post('accounts') @RequirePermission('accounting.manage')
  async createAccount(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { await this.own(req, s); return this.svc.createAccount(s, b); }

  @Patch('accounts/:key') @RequirePermission('accounting.manage')
  async updateAccount(@Req() req: any, @Param('storeId') s: string, @Param('key') key: string, @Body() b: any) { await this.own(req, s); return this.svc.updateAccount(s, key, b); }

  @Put('opening-balances') @RequirePermission('accounting.manage')
  async opening(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { const { actor } = await this.own(req, s); return this.svc.setOpeningBalances(s, b, actor); }

  @Get('journal') @RequirePermission('accounting.view')
  async journal(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.svc.journalList(s, q); }

  @Get('journal/:id') @RequirePermission('accounting.view')
  async entry(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(req, s); return this.svc.entry(s, id); }

  @Post('journal') @RequirePermission('accounting.manage')
  async manual(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { const { actor } = await this.own(req, s); return this.svc.manualEntry(s, b, actor); }

  @Post('journal/:id/reverse') @RequirePermission('accounting.manage')
  async reverse(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) {
    const { actor } = await this.own(req, s);
    return this.svc.reverse(s, id, actor, typeof b?.memo === 'string' ? b.memo.slice(0, 200) : '');
  }

  @Get('trial-balance') @RequirePermission('accounting.view')
  async trialBalance(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.svc.trialBalance(s, q); }

  @Get('ledger/:key') @RequirePermission('accounting.view')
  async ledger(@Req() req: any, @Param('storeId') s: string, @Param('key') key: string, @Query() q: any) { await this.own(req, s); return this.svc.accountLedger(s, key, q); }
}
