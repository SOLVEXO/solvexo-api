/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Param, Body, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminFinanceService } from './admin-finance.service';
import { AdminAnalyticsQueryDto } from '../admin-analytics/dto/admin-analytics-query.dto';
import { SellerBalancesQueryDto } from './dto/seller-balances-query.dto';
import { AdminTransactionsQueryDto } from './dto/admin-transactions-query.dto';
import { PayoutQueueQueryDto } from './dto/payout-queue-query.dto';
import { RejectPayoutDto } from './dto/reject-payout.dto';
import { ManualPayoutDto } from './dto/manual-payout.dto';
import { AdminFinanceExportQueryDto } from './dto/admin-finance-export-query.dto';
import { VerifyPayoutMethodDto } from './dto/verify-payout-method.dto';
import { TransactionFeeBillsQueryDto } from './dto/transaction-fee-bills-query.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RequireApproval } from '../auth/decorators/admin-guards.decorator';
@ApiTags('Admin Finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/finance')
export class AdminFinanceController {
  constructor(private readonly adminFinanceService: AdminFinanceService) {}

  // ─── Dashboard ───────────────────────────────────────────────────────────

  @RequirePermission('finance.view')
  @Get('overview')
  getOverview(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getOverview(query);
  }

  /** What sellers pay Solvexo: plan revenue + collected third-party transaction fees (USD). */
  @RequirePermission('finance.view')
  @Get('platform-revenue')
  getPlatformRevenue(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getPlatformRevenue(query);
  }

  @RequirePermission('finance.view')
  @Get('revenue-over-time')
  getRevenueOverTime(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getRevenueOverTime(query);
  }

  @RequirePermission('finance.view')
  @Get('commission-over-time')
  getCommissionOverTime(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getCommissionOverTime(query);
  }

  // ─── Reconciliation & FX exposure ───────────────────────────────────────

  @RequirePermission('finance.view')
  @Get('reconciliation')
  getReconciliation(@Query('days') days?: string) {
    return this.adminFinanceService.getReconciliationUsd(days ? Number(days) : 1);
  }

  @RequirePermission('finance.view')
  @Get('reconciliation/history')
  getReconciliationHistory(@Query('limit') limit?: string) {
    return this.adminFinanceService.getReconciliationHistory(limit ? Number(limit) : 30);
  }

  @RequirePermission('finance.view')
  @Get('fx-exposure')
  getFxExposure() {
    return this.adminFinanceService.getFxExposure();
  }

  // ─── Seller balances & drill-down ────────────────────────────────────────

  @RequirePermission('finance.view')
  @Get('sellers/balances')
  getSellerBalances(@Query() query: SellerBalancesQueryDto) {
    return this.adminFinanceService.getSellerBalances(query);
  }

  @RequirePermission('finance.view')
  @Get('sellers/:storeId')
  getSellerFinancialDetails(@Param('storeId') storeId: string) {
    return this.adminFinanceService.getSellerFinancialDetails(storeId);
  }

  @RequirePermission('finance.view')
  @Get('sellers/:storeId/transactions')
  getSellerTransactions(@Param('storeId') storeId: string, @Query() query: AdminTransactionsQueryDto) {
    return this.adminFinanceService.getSellerTransactions(storeId, query);
  }

  @RequirePermission('finance.payouts')
  @RequireApproval('payout.manual')
  @Post('sellers/:storeId/payouts/manual')
  createManualPayout(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: ManualPayoutDto) {
    return this.adminFinanceService.createManualPayout(storeId, req.user.userId, dto.amount, dto.payoutMethodId, dto.notes, req.ip, req.headers['user-agent']);
  }

  // ─── Cross-store seller rollup (Clients workspace's Finance tab) — a
  // distinct path segment (`sellers-by-id`, not `sellers`) from the
  // store-scoped routes above so `:sellerId` never collides with `:storeId`
  // on the same route shape. ────────────────────────────────────────────────

  @RequirePermission('finance.view')
  @Get('sellers-by-id/:sellerId/summary')
  getSellerFinancialRollup(@Param('sellerId') sellerId: string) {
    return this.adminFinanceService.getSellerFinancialRollup(sellerId);
  }

  @RequirePermission('finance.view')
  @Get('sellers-by-id/:sellerId/transactions')
  getSellerTransactionsBySeller(@Param('sellerId') sellerId: string, @Query() query: AdminTransactionsQueryDto) {
    return this.adminFinanceService.getSellerTransactionsBySeller(sellerId, query);
  }

  // ─── Platform transactions ───────────────────────────────────────────────

  @RequirePermission('finance.view')
  @Get('transactions')
  getPlatformTransactions(@Query() query: AdminTransactionsQueryDto) {
    return this.adminFinanceService.getPlatformTransactions(query);
  }

  // ─── Payout queue & lifecycle ────────────────────────────────────────────

  @RequirePermission('finance.view')
  @Get('transaction-fee-bills')
  getTransactionFeeBills(@Query() query: TransactionFeeBillsQueryDto) {
    return this.adminFinanceService.getTransactionFeeBills(query);
  }

  @RequirePermission('finance.view')
  @Get('payouts')
  getPayoutQueue(@Query() query: PayoutQueueQueryDto) {
    return this.adminFinanceService.getPayoutQueue(query);
  }

  @RequirePermission('finance.payouts')
  @RequireApproval('payout.approve')
  @Patch('payouts/:payoutId/approve')
  approvePayout(@Req() req: any, @Param('payoutId') payoutId: string) {
    return this.adminFinanceService.approvePayout(payoutId, req.user.userId, req.ip, req.headers['user-agent']);
  }

  @RequirePermission('finance.payouts')
  @Patch('payouts/:payoutId/reject')
  rejectPayout(@Req() req: any, @Param('payoutId') payoutId: string, @Body() dto: RejectPayoutDto) {
    return this.adminFinanceService.rejectPayout(payoutId, req.user.userId, dto.reason, req.ip, req.headers['user-agent']);
  }

  @RequirePermission('finance.payouts')
  @Patch('payouts/:payoutId/retry')
  retryPayout(@Req() req: any, @Param('payoutId') payoutId: string) {
    return this.adminFinanceService.retryPayout(payoutId, req.user.userId, req.ip, req.headers['user-agent']);
  }

  @RequirePermission('finance.payouts')
  @RequireApproval('payout.reverse')
  @Patch('payouts/:payoutId/reverse')
  reversePayout(@Req() req: any, @Param('payoutId') payoutId: string, @Body() dto: RejectPayoutDto) {
    return this.adminFinanceService.reversePayout(payoutId, req.user.userId, dto.reason);
  }

  @RequirePermission('finance.payouts')
  @Post('process-clearing')
  triggerClearingBalances() {
    return this.adminFinanceService.triggerClearingBalances();
  }

  @RequirePermission('finance.payouts')
  @Post('process-scheduled-payouts')
  triggerScheduledPayouts() {
    return this.adminFinanceService.triggerScheduledPayouts();
  }

  // ─── Payout method verification ──────────────────────────────────────────

  @RequirePermission('finance.view')
  @Get('payout-methods/pending-verification')
  getPendingVerificationMethods() {
    return this.adminFinanceService.getPendingVerificationMethods();
  }

  @RequirePermission('finance.payouts')
  @Patch('sellers/:storeId/payout-methods/:methodId/verify')
  verifyPayoutMethod(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('methodId') methodId: string,
    @Body() dto: VerifyPayoutMethodDto,
  ) {
    return this.adminFinanceService.verifyPayoutMethod(storeId, methodId, req.user.userId, dto.approve, dto.note);
  }

  // ─── Reports ─────────────────────────────────────────────────────────────

  @RequirePermission('finance.view')
  @Get('reports/refunds')
  getRefundReport(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getRefundReport(query);
  }

  @RequirePermission('finance.view')
  @Get('reports/tax')
  getTaxReports(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getTaxReports(query);
  }

  @RequirePermission('finance.view')
  @Get('reports/settlement')
  getSettlementReport(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getSettlementReport(query);
  }

  @RequirePermission('finance.view')
  @Get('reports/monthly')
  getMonthlyReport(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminFinanceService.getMonthlyReport(query);
  }

  // ─── Export ──────────────────────────────────────────────────────────────

  @RequirePermission('finance.view')
  @Get('export')
  async export(@Query() query: AdminFinanceExportQueryDto, @Res() res: Response) {
    if (query.format === 'pdf') {
      const pdf = await this.adminFinanceService.exportPdf(query);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="admin-finance-report.pdf"');
      res.send(pdf);
      return;
    }

    const csv = await this.adminFinanceService.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="admin-finance-${query.section ?? 'transactions'}.csv"`);
    res.send(csv);
  }
}
