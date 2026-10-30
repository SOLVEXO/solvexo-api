/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { DigitalAccessService } from './digital-access.service';
import { DigitalDeliveryService } from './digital-delivery.service';

class DownloadTokenDto {
  @IsString() @IsNotEmpty() productId: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(1000) fileIndex: number;
  @IsOptional() @IsString() storeId?: string;
}

const ctxOf = (req: any) => ({ ip: String(req.ip ?? ''), userAgent: String(req.headers?.['user-agent'] ?? '') });

/** Buyer side: library + single-use download tokens. */
@ApiTags('Digital access (buyer)')
@Controller('api/digital')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class DigitalBuyerController {
  constructor(private readonly access: DigitalAccessService, private readonly delivery: DigitalDeliveryService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('library')
  library(@Req() req: any, @Query('storeId') storeIdQuery: string) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);
    return this.access.library(storeId, req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('download-token')
  token(@Req() req: any, @Body() dto: DownloadTokenDto) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, dto.storeId);
    return this.delivery.mintToken(storeId, req.user.userId, dto.productId, dto.fileIndex, ctxOf(req));
  }

  // Token-only (browser download link): single use, 5 min.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('download/:token')
  async download(@Req() req: any, @Res() res: Response, @Param('token') token: string) {
    const { buffer, fileName, mimeType } = await this.delivery.redeem(token, ctxOf(req));
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${fileName.replace(/[^\w.\- ]/g, '_')}"`,
      'Content-Length': buffer.length,
      'Cache-Control': 'private, no-store',
    });
    res.end(buffer);
  }
}

/** Seller side. Permissions reuse orders.* until the dedicated digital.* keys exist (M8). */
@ApiTags('Digital access (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@Controller('api/digital/:storeId')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class DigitalSellerController {
  constructor(private readonly access: DigitalAccessService, private readonly db: DatabaseService) {}

  private async own(req: any, storeId: string) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
  }

  @Get('orders/:orderId/access')
  @RequirePermission('orders.view')
  async forOrder(@Req() req: any, @Param('storeId') storeId: string, @Param('orderId') orderId: string) {
    await this.own(req, storeId);
    return this.access.listForOrder(storeId, orderId);
  }

  @Get('delivery-log')
  @RequirePermission('orders.view')
  async log(@Req() req: any, @Param('storeId') storeId: string, @Query('limit') limit?: string, @Query('customerId') customerId?: string) {
    await this.own(req, storeId);
    return this.access.deliveryLog(storeId, Number(limit) || 50, customerId);
  }

  @Post('access/:id/revoke')
  @RequirePermission('orders.edit')
  async revoke(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    await this.own(req, storeId);
    return this.access.sellerRevoke(storeId, id, req.user.userId ?? req.user.staffId ?? 'seller');
  }

  @Post('access/:id/reset-limit')
  @RequirePermission('orders.edit')
  async reset(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    await this.own(req, storeId);
    return this.access.sellerResetLimit(storeId, id, req.user.userId ?? req.user.staffId ?? 'seller');
  }

  @Post('access/:id/resend')
  @RequirePermission('orders.edit')
  async resend(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    await this.own(req, storeId);
    return this.access.sellerResend(storeId, id, req.user.userId ?? req.user.staffId ?? 'seller');
  }
}
