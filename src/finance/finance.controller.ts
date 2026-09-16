/* eslint-disable prettier/prettier */
import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, Req, Res, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FinanceService } from './finance.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { RequestPayoutDto } from './dto/request-payout.dto';
import { AddPayoutMethodDto } from './dto/add-payout-method.dto';
import { UpdatePayoutScheduleDto } from './dto/update-payout-schedule.dto';

@ApiTags('Finance & Payouts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/finance')
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/dashboard')
  getDashboard(@Req() req: any, @Param('storeId') storeId: string) {
    return this.financeService.getDashboard(actingSellerId(req.user), storeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSACTIONS  (static routes before parameterized)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/transactions/export')
  async exportCsv(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
    @Res() res: Response,
  ) {
    const csv = await this.financeService.exportTransactionsCsv(actingSellerId(req.user), storeId, query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${storeId}.csv"`);
    res.send(csv);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/transactions')
  getTransactions(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.financeService.getTransactions(actingSellerId(req.user), storeId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/analytics')
  getAnalytics(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.financeService.getAnalytics(actingSellerId(req.user), storeId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUTS  (static before parameterized)
  // ═══════════════════════════════════════════════════════════════════════════

  @Post(':storeId/payouts/request')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  requestPayout(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: RequestPayoutDto) {
    return this.financeService.requestPayout(req.user.userId, storeId, dto);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/payouts')
  getPayouts(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.financeService.getPayouts(actingSellerId(req.user), storeId, query);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/payouts/:payoutId')
  getPayoutById(@Req() req: any, @Param('storeId') storeId: string, @Param('payoutId') payoutId: string) {
    return this.financeService.getPayoutById(actingSellerId(req.user), storeId, payoutId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUT METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  @Post(':storeId/payout-methods')
  addPayoutMethod(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AddPayoutMethodDto) {
    return this.financeService.addPayoutMethod(req.user.userId, storeId, dto);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/payout-methods')
  getPayoutMethods(@Req() req: any, @Param('storeId') storeId: string) {
    return this.financeService.getPayoutMethods(actingSellerId(req.user), storeId);
  }

  // Static set-default route BEFORE /:methodId
  @Patch(':storeId/payout-methods/:methodId/default')
  setDefault(@Req() req: any, @Param('storeId') storeId: string, @Param('methodId') methodId: string) {
    return this.financeService.setDefaultPayoutMethod(req.user.userId, storeId, methodId);
  }

  @Patch(':storeId/payout-methods/:methodId')
  updatePayoutMethod(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('methodId') methodId: string,
    @Body() dto: AddPayoutMethodDto,
  ) {
    return this.financeService.updatePayoutMethod(req.user.userId, storeId, methodId, dto);
  }

  @Delete(':storeId/payout-methods/:methodId')
  deletePayoutMethod(@Req() req: any, @Param('storeId') storeId: string, @Param('methodId') methodId: string) {
    return this.financeService.deletePayoutMethod(req.user.userId, storeId, methodId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUT SCHEDULE
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/payout-schedule')
  getPayoutSchedule(@Req() req: any, @Param('storeId') storeId: string, @Query('currency') currency?: string) {
    return this.financeService.getPayoutSchedule(actingSellerId(req.user), storeId, currency || 'USD');
  }

  @Patch(':storeId/payout-schedule')
  updatePayoutSchedule(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdatePayoutScheduleDto) {
    return this.financeService.updatePayoutSchedule(req.user.userId, storeId, dto, req.ip, req.headers['user-agent']);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TAX REPORTS  (static generate route BEFORE parameterized)
  // ═══════════════════════════════════════════════════════════════════════════

  // Real "Tax documents" permission — previously this generate action had
  // no staff path/permission at all (only the read-side `getTaxReports`
  // below was gated, under `finance.payouts.view`). Genuinely generated
  // financial REPORTS, not literal government-compliant tax forms — see
  // this app's disclosed "no tax handling" boundary elsewhere.
  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.tax_documents.manage')
  @Post(':storeId/tax-reports/generate')
  generateTaxReport(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query('year') year: string,
    @Query('period') period: string,
    @Query('currency') currency?: string,
  ) {
    return this.financeService.generateTaxReport(
      actingSellerId(req.user), storeId,
      parseInt(year) || new Date().getFullYear(),
      period || 'q1',
      currency || 'USD',
    );
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/tax-reports')
  getTaxReports(@Req() req: any, @Param('storeId') storeId: string) {
    return this.financeService.getTaxReports(actingSellerId(req.user), storeId);
  }

  // Real downloadable tax document — see FinanceService.buildTaxReportPdf's
  // doc comment for why this streams on-demand rather than populating
  // TaxReport.pdfUrl. Same view-level permission as the list route above.
  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('finance.payouts.view')
  @Get(':storeId/tax-reports/:reportId/pdf')
  async downloadTaxReportPdf(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('reportId') reportId: string,
    @Res() res: Response,
  ) {
    const pdf = await this.financeService.buildTaxReportPdf(actingSellerId(req.user), storeId, reportId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="tax-report.pdf"');
    res.send(pdf);
  }
}
