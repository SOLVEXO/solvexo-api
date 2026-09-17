/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { TopProductsQueryDto } from './dto/top-products-query.dto';
import { ProductPerformanceQueryDto } from './dto/product-performance-query.dto';
import { ExportQueryDto } from './dto/export-query.dto';

// Every route in this controller is a real-time VIEW of analytics data —
// gated on one permission (`analytics.view`) at class level, matching
// Shopify's own "Dashboards" real-permission scope (see the project plan).
// `export` (PDF/CSV, Shopify's "Reports" scope — Partial, not yet split
// into its own permission) explicitly overrides back to seller/admin-only.
@ApiTags('Seller Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'admin', 'staff')
@RequirePermission('analytics.view')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/seller/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('today')
  getTodaySummary(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getTodaySummary(actingSellerId(req.user), query.storeId);
  }

  // ─── Every route below accepts an optional `storeId` on its DTO — present,
  // it scopes to that one store (ownership verified); omitted, it aggregates
  // across every store the seller owns, powering the cross-store view.

  @Get('overview')
  getOverview(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getOverview(actingSellerId(req.user), query.storeId, query);
  }

  @Get('revenue-over-time')
  getRevenueOverTime(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getRevenueOverTime(actingSellerId(req.user), query.storeId, query);
  }

  // Real trend+seasonality sales forecast — see AnalyticsService's own doc
  // comment for the method used and its honest fallback.
  @Get('sales-forecast')
  getSalesForecast(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getSalesForecast(actingSellerId(req.user), query.storeId);
  }

  // Real slow/busy-day detection for Marketing/Discounts — see
  // AnalyticsService's own doc comment.
  @Get('weekday-performance')
  getWeekdayPerformance(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getWeekdayPerformance(actingSellerId(req.user), query.storeId);
  }

  @Get('orders-over-time')
  getOrdersOverTime(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getOrdersOverTime(actingSellerId(req.user), query.storeId, query);
  }

  @Get('traffic-sources')
  getTrafficSources(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getTrafficSources(actingSellerId(req.user), query.storeId, query);
  }

  @Get('top-products')
  getTopProducts(@Req() req: any, @Query() query: TopProductsQueryDto) {
    return this.analyticsService.getTopProducts(actingSellerId(req.user), query.storeId, query);
  }

  // Real week-over-week growth detection — see AnalyticsService's own doc
  // comment for the method used.
  @Get('trending-products')
  getTrendingProducts(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getTrendingProducts(actingSellerId(req.user), query.storeId);
  }

  @Get('customers')
  getCustomerAnalytics(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getCustomerAnalytics(actingSellerId(req.user), query.storeId, query);
  }

  @Get('products/performance')
  getProductPerformance(@Req() req: any, @Query() query: ProductPerformanceQueryDto) {
    return this.analyticsService.getProductPerformance(actingSellerId(req.user), query.storeId, query);
  }

  @Get('inventory-insights')
  getInventoryInsights(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getInventoryInsights(actingSellerId(req.user), query.storeId);
  }

  @Get('payment-methods')
  getPaymentMethods(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getPaymentMethods(actingSellerId(req.user), query.storeId, query);
  }

  @Get('revenue-breakdown')
  getRevenueBreakdown(@Req() req: any, @Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getRevenueBreakdown(actingSellerId(req.user), query.storeId, query);
  }

  // Real "saved custom report" — see AnalyticsService's Saved Reports
  // section doc comment. Stays under the class-level `analytics.view`
  // permission (a natural extension of viewing/analyzing data, not the
  // seller-only `export` action below, which is unchanged). `storeId` stays
  // a query param, matching every sibling route in this controller.
  @Get('saved-reports')
  listSavedReports(@Req() req: any, @Query('storeId') storeId: string) {
    return this.analyticsService.listSavedReports(actingSellerId(req.user), storeId);
  }

  @Post('saved-reports')
  createSavedReport(@Req() req: any, @Query('storeId') storeId: string, @Body() body: { name: string; config: Record<string, unknown> }) {
    return this.analyticsService.createSavedReport(actingSellerId(req.user), storeId, body);
  }

  @Delete('saved-reports/:reportId')
  deleteSavedReport(@Req() req: any, @Query('storeId') storeId: string, @Param('reportId') reportId: string) {
    return this.analyticsService.deleteSavedReport(actingSellerId(req.user), storeId, reportId);
  }

  @Roles('seller', 'admin')
  @Get('export')
  async export(@Req() req: any, @Query() query: ExportQueryDto, @Res() res: Response) {
    const sellerId = req.user.userId;

    if (query.format === 'pdf') {
      const pdf = await this.analyticsService.exportPdf(sellerId, query.storeId, query);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="analytics-report.pdf"');
      res.send(pdf);
      return;
    }

    const csv = await this.analyticsService.exportCsv(sellerId, query.storeId, query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="analytics-${query.section ?? 'revenue'}.csv"`);
    res.send(csv);
  }
}
