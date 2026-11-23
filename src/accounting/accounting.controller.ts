/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
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
import { AccountingBooksService } from './accounting-books.service';
import { AccountingStatementsService } from './accounting-statements.service';
import { AccountingSettlementsService } from './accounting-settlements.service';

/** The store's books (Accounting Plan, Phase 1). Permissions: accounting.view (read) / accounting.manage (setup, entries, sync). */
@ApiTags('Accounting (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/accounting/:storeId')
export class AccountingController {
  constructor(private readonly svc: AccountingService, private readonly sync: AccountingSyncService, private readonly books: AccountingBooksService, private readonly statements: AccountingStatementsService,
    private readonly settlements: AccountingSettlementsService, private readonly db: DatabaseService) {}

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
  // ── Phase 2: expenses, cash book, supplier balances, POS profit and tax ─────────────────────────────────────────────

  @Get('expenses') @RequirePermission('accounting.view')
  async expenses(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { const { store } = await this.own(req, s); return this.books.expenses(store, q); }

  @Post('expenses') @RequirePermission('accounting.manage')
  async createExpense(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { const { store, actor } = await this.own(req, s); return this.books.createExpense(store, b, actor); }

  @Get('expenses/:id') @RequirePermission('accounting.view')
  async expense(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { const { store } = await this.own(req, s); return this.books.expense(store, id); }

  @Post('expenses/:id/decision') @RequirePermission('accounting.manage')
  async decide(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { const { store } = await this.own(req, s); return this.books.decide(store, id, b); }

  @Post('expenses/:id/receipt') @RequirePermission('accounting.manage')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: Number(process.env.EXPENSE_RECEIPT_MAX_BYTES) >= 1024 ? Number(process.env.EXPENSE_RECEIPT_MAX_BYTES) : 5 * 1024 * 1024 } }))
  async receipt(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) { const { store } = await this.own(req, s); return this.books.receiptUpload(store, id, file); }

  @Get('expenses/:id/receipt') @RequirePermission('accounting.view')
  async receiptLink(@Req() req: any, @Res({ passthrough: true }) res: any, @Param('storeId') s: string, @Param('id') id: string) {
    const { store } = await this.own(req, s);
    res.setHeader('Cache-Control', 'no-store');
    return this.books.receiptLink(store, id);
  }

  @Get('expense-accounts') @RequirePermission('accounting.view')
  async expenseAccounts(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); await this.svc.requireEnabled(s); return this.books.expenseAccounts(s); }

  @Put('expense-accounts') @RequirePermission('accounting.manage')
  async setExpenseAccounts(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { await this.own(req, s); await this.svc.requireEnabled(s); return this.books.setExpenseAccounts(s, b); }

  @Get('daybook') @RequirePermission('accounting.view')
  async daybook(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { const { store } = await this.own(req, s); return this.books.daybook(store, q); }

  @Get('payables') @RequirePermission('accounting.view')
  async payables(@Req() req: any, @Param('storeId') s: string) { const { store } = await this.own(req, s); return this.books.payables(store); }

  @Get('payables/:supplierId') @RequirePermission('accounting.view')
  async supplierLedger(@Req() req: any, @Param('storeId') s: string, @Param('supplierId') id: string) { const { store } = await this.own(req, s); return this.books.supplierLedger(store, id); }

  @Get('reports/profit') @RequirePermission('accounting.view')
  async profit(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { const { store } = await this.own(req, s); return this.books.profit(store, q); }

  @Get('reports/tax') @RequirePermission('accounting.view')
  async tax(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { const { store } = await this.own(req, s); return this.books.tax(store, q); }
  // ── Phase 3: statements, Excel, gateway settlements ─────────────────────────────────────────────────────────────────

  @Get('statements/profit-and-loss') @RequirePermission('accounting.view')
  async pnl(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.statements.profitAndLoss(s, q); }

  @Get('statements/balance-sheet') @RequirePermission('accounting.view')
  async balanceSheet(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.statements.balanceSheet(s, q); }

  @Get('statements/sales-tax') @RequirePermission('accounting.view')
  async salesTax(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.statements.salesTax(s, q); }

  /** An Excel file. kind: profit-and-loss | balance-sheet | sales-tax | trial-balance (same query as the screen). */
  @Get('exports/:kind') @RequirePermission('accounting.view')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async excel(@Req() req: any, @Param('storeId') s: string, @Param('kind') kind: string, @Query() q: any) {
    await this.own(req, s); await this.svc.requireEnabled(s);
    const { buffer, fileName } = await this.statements.excel(s, kind, q);
    return new StreamableFile(buffer, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', disposition: `attachment; filename="${fileName}"` });
  }

  @Get('settlements') @RequirePermission('accounting.view')
  async settlementList(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.settlements.list(s); }

  @Post('settlements') @RequirePermission('accounting.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async settlementImport(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { const { actor } = await this.own(req, s); return this.settlements.import(s, b, actor); }

  @Get('settlements/:id') @RequirePermission('accounting.view')
  async settlement(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(req, s); return this.settlements.get(s, id); }

  @Post('settlements/:id/post') @RequirePermission('accounting.manage')
  async settlementPost(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { const { actor } = await this.own(req, s); return this.settlements.post(s, id, actor); }

  @Post('settlements/:id/discard') @RequirePermission('accounting.manage')
  async settlementDiscard(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { await this.own(req, s); return this.settlements.discard(s, id); }
}
