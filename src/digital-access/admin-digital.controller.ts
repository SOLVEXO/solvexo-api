/* eslint-disable prettier/prettier */
import { Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { DatabaseService } from '../database/databaseservice';
import { DigitalAccessService } from './digital-access.service';

class DisableDto { @IsBoolean() disabled: boolean; @IsOptional() @IsString() @MaxLength(300) reason?: string; }

/**
 * Super-admin side of digital delivery. The platform never touches a seller's sale money and sees
 * NO customer data here: only aggregate counts and two safety switches (abuse / piracy handling).
 */
@ApiTags('Admin digital')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@RequirePermission('config.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/digital')
export class AdminDigitalController {
  constructor(private readonly db: DatabaseService, private readonly access: DigitalAccessService) {}

  /** Platform-wide counters only (no names, emails or store data). */
  @Get('overview')
  async overview() {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [activeAccess, flagged, deliveries, denied, disabledStores] = await Promise.all([
      this.access.accessModel.countDocuments({ status: 'active' }),
      this.access.accessModel.countDocuments({ flagged: true, status: 'active' }),
      this.access.logModel.countDocuments({ outcome: 'ok', at: { $gte: since } }),
      this.access.logModel.countDocuments({ outcome: { $ne: 'ok' }, at: { $gte: since } }),
      (this.db.repositories.storeModel as any).countDocuments({ digitalDisabled: true, isDelete: false }),
    ]);
    return { activeAccess, flaggedAccess: flagged, last30Days: { deliveries, deniedOrFailed: denied }, storesWithDigitalDisabled: disabledStores };
  }

  /** Suspend (or restore) digital delivery for one store: downloads, course media and licenses stop answering. */
  @Post('stores/:storeId/disable')
  async disableStore(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: DisableDto) {
    const r = await (this.db.repositories.storeModel as any).updateOne({ _id: storeId, isDelete: false }, { $set: { digitalDisabled: dto.disabled, digitalDisabledReason: dto.disabled ? dto.reason ?? null : null } });
    if (!r.matchedCount) throw new NotFoundException('Store not found');
    return { success: true, disabled: dto.disabled };
  }

  /** Piracy / abuse takedown of one digital product: every access to it is revoked and the product is archived. */
  @Post('products/:productId/takedown')
  async takedown(@Req() req: any, @Param('productId') productId: string) {
    const product: any = await this.db.repositories.productModel.findOne({ _id: productId, type: 'digital' }).select('storeId').lean().catch(() => null);
    if (!product) throw new NotFoundException('Product not found');
    const revoked = await this.access.accessModel.updateMany(
      { storeId: product.storeId, resourceKind: 'file', resourceRef: productId, status: { $ne: 'revoked' } },
      { $set: { status: 'revoked' }, $push: { audit: { at: new Date(), action: 'revoked', by: `admin:${req.user.userId}`, note: 'takedown' } } },
    );
    await this.db.repositories.productModel.updateOne({ _id: productId }, { $set: { status: 'archived' } });
    return { success: true, accessRevoked: revoked.modifiedCount };
  }
}
