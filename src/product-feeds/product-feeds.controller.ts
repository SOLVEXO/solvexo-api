/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { ProductFeedsService } from './product-feeds.service';

@ApiTags('Sales channels (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/feeds/:storeId')
export class ProductFeedsController {
  constructor(private readonly svc: ProductFeedsService, private readonly db: DatabaseService) {}
  private own(req: any, s: string) { return verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, s, actingSellerId(req.user)); }
  @Get() @RequirePermission('products.view') async get(@Req() r: any, @Param('storeId') s: string) { await this.own(r, s); return this.svc.getSettings(s); }
  @Patch() @RequirePermission('marketing.manage') async set(@Req() r: any, @Param('storeId') s: string, @Body() b: any) { await this.own(r, s); return this.svc.update(s, b); }
  @Post('rotate') @RequirePermission('marketing.manage') async rotate(@Req() r: any, @Param('storeId') s: string) { await this.own(r, s); return this.svc.rotate(s); }
  @Get('health') @RequirePermission('products.view') async health(@Req() r: any, @Param('storeId') s: string) { await this.own(r, s); return this.svc.health(s); }
}

/** Public, tokenized, read-only feeds for Google Merchant Center and Meta catalog. No account or key of ours is needed. */
@ApiTags('Product feeds (public)')
@Controller('api/public/feeds/:storeId/:token')
export class PublicProductFeedsController {
  constructor(private readonly svc: ProductFeedsService) {}
  private async send(res: Response, p: Promise<{ type: string; body: string }>) { const r = await p; res.setHeader('Content-Type', r.type); res.setHeader('Cache-Control', 'private, max-age=300'); res.send(r.body); }
  @Get('google.xml') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  google(@Param('storeId') s: string, @Param('token') t: string, @Query('currency') c: string | undefined, @Res() res: Response) { return this.send(res, this.svc.publicFeed(s, t, 'google', c)); }
  @Get('meta.csv') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  meta(@Param('storeId') s: string, @Param('token') t: string, @Query('currency') c: string | undefined, @Res() res: Response) { return this.send(res, this.svc.publicFeed(s, t, 'meta', c)); }
}
