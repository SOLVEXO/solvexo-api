/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosReportsService } from './pos-reports.service';
import { PosStoreSettingsService, RECEIPT_LOGO_MAX_BYTES } from './pos-store-settings.service';

/** G4.0 / G4.1 — business pulse and the eight reports (read-only, live from the ledgers, store time zone). Reads stay available on a lapsed plan. */
@ApiTags('POS reports')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/reports')
export class PosReportsController {
  constructor(private readonly svc: PosReportsService) {}

  /** G5.7: accounting export (CSV, store time zone, minor units + formatted amounts; cost columns obey hide-costs; audited). */
  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('accounting-export/:storeId')
  async accountingExport(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Res() res: Response, @Headers('x-pos-employee-token') e?: string) {
    const out = await this.svc.accountingCsv(req, s, q, { employee: e });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Rows', String(out.rows));
    res.setHeader('X-Costs-Included', String(out.costsIncluded));
    res.send(out.csv);
  }
  private t = (e?: string) => ({ employee: e });

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('pulse/:storeId')
  pulse(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.pulse(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('sales/:storeId')
  sales(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.sales(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('profit/:storeId')
  profit(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.profit(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('products/:storeId')
  products(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.products(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('categories/:storeId')
  categories(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.categories(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('tax/:storeId')
  tax(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.tax(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('payments/:storeId')
  payments(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.payments(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('cashiers/:storeId')
  cashiers(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.cashiers(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('hourly/:storeId')
  hourly(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.hourly(req, s, q, this.t(e)); }
}

/** G4.0 — the store's time zone (every day boundary of the till uses it). Anyone signed in reads it; the owner changes it. */
@ApiTags('POS store')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/store')
export class PosStoreController {
  constructor(private readonly svc: PosReportsService, private readonly settings: PosStoreSettingsService) {}

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('settings/:storeId')
  getSettings(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.settings.get(req, s, { employee: e }); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('settings/:storeId')
  setSettings(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.settings.update(req, s, body, { employee: e }); }

  // G5.6: the receipt logo (owner only; content-checked image, resized; audited)
  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: RECEIPT_LOGO_MAX_BYTES } }))
  @Post('settings/:storeId/receipt-logo')
  uploadLogo(@Req() req: any, @Param('storeId') s: string, @UploadedFile() file: Express.Multer.File, @Headers('x-pos-employee-token') e?: string) { return this.settings.uploadReceiptLogo(req, s, file, { employee: e }); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('settings/:storeId/receipt-logo/remove')
  removeLogo(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.settings.removeReceiptLogo(req, s, { employee: e }); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('sync-status/:storeId')
  syncStatus(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.settings.syncStatus(req, s, { employee: e }); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('time-zone/:storeId')
  timeZone(@Req() req: any, @Param('storeId') s: string) { return this.svc.timeZone(req, s); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('time-zone/:storeId')
  setTimeZone(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.setTimeZone(req, s, body, { employee: e }); }
}
