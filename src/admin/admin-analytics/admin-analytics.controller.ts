/* eslint-disable prettier/prettier */
import { Controller, Get, Query, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminAnalyticsQueryDto } from './dto/admin-analytics-query.dto';
import { TopSellersQueryDto } from './dto/top-sellers-query.dto';
import { SellerPerformanceQueryDto } from './dto/seller-performance-query.dto';
import { AdminTopProductsQueryDto } from './dto/top-products-query.dto';
import { TopCategoriesQueryDto } from './dto/top-categories-query.dto';
import { AdminProductPerformanceQueryDto } from './dto/product-performance-query.dto';
import { AdminExportQueryDto } from './dto/export-query.dto';

@ApiTags('Admin Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly adminAnalyticsService: AdminAnalyticsService) {}

  // ─── Dashboard overview ─────────────────────────────────────────────────

  @Get('overview')
  getOverview(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getOverview(query);
  }

  // ─── Revenue analytics ──────────────────────────────────────────────────

  @Get('revenue-over-time')
  getRevenueOverTime(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getRevenueOverTime(query);
  }

  @Get('revenue-breakdown')
  getRevenueBreakdown(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getRevenueBreakdown(query);
  }

  // ─── Seller analytics ───────────────────────────────────────────────────

  @Get('sellers/top')
  getTopSellers(@Query() query: TopSellersQueryDto) {
    return this.adminAnalyticsService.getTopSellers(query);
  }

  @Get('sellers/performance')
  getSellerPerformance(@Query() query: SellerPerformanceQueryDto) {
    return this.adminAnalyticsService.getSellerPerformance(query);
  }

  @Get('sellers/registration-trends')
  getSellerRegistrationTrends(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getSellerRegistrationTrends(query);
  }

  // ─── Customer analytics ─────────────────────────────────────────────────

  @Get('customers')
  getCustomerAnalytics(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getCustomerAnalytics(query);
  }

  // ─── Product analytics ──────────────────────────────────────────────────

  @Get('products/top')
  getTopProducts(@Query() query: AdminTopProductsQueryDto) {
    return this.adminAnalyticsService.getTopProducts(query);
  }

  @Get('categories/top')
  getTopCategories(@Query() query: TopCategoriesQueryDto) {
    return this.adminAnalyticsService.getTopCategories(query);
  }

  @Get('products/performance')
  getProductPerformance(@Query() query: AdminProductPerformanceQueryDto) {
    return this.adminAnalyticsService.getProductPerformance(query);
  }

  @Get('inventory-insights')
  getInventoryInsights(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getInventoryInsights(query);
  }

  // ─── Order analytics ────────────────────────────────────────────────────

  @Get('orders-over-time')
  getOrdersOverTime(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getOrdersOverTime(query);
  }

  @Get('orders/status-breakdown')
  getOrderStatusBreakdown(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getOrderStatusBreakdown(query);
  }

  // ─── Payment analytics ──────────────────────────────────────────────────

  @Get('payments/breakdown')
  getPaymentBreakdown(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getPaymentBreakdown(query);
  }

  // ─── Platform analytics ─────────────────────────────────────────────────

  @Get('platform-metrics')
  getPlatformMetrics(@Query() query: AdminAnalyticsQueryDto) {
    return this.adminAnalyticsService.getPlatformMetrics(query);
  }

  // ─── Export ──────────────────────────────────────────────────────────────

  @Get('export')
  async export(@Query() query: AdminExportQueryDto, @Res() res: Response) {
    if (query.format === 'pdf') {
      const pdf = await this.adminAnalyticsService.exportPdf(query);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="admin-analytics-report.pdf"');
      res.send(pdf);
      return;
    }

    const csv = await this.adminAnalyticsService.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="admin-analytics-${query.section ?? 'revenue'}.csv"`);
    res.send(csv);
  }
}
