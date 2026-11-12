/* eslint-disable prettier/prettier */
import { Controller, Get, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { PlatformInvoice, PlatformInvoiceDocument } from './schemas/platform-invoice.schema';
import { isPlatformLedgerEnabled } from './platform-ledger.service';
import { LEDGER_SOURCE_TYPES } from '../tax-core/legal-invoice.types';

class LedgerListQueryDto {
  @IsOptional() @IsIn(LEDGER_SOURCE_TYPES) sourceType?: string;
  @IsOptional() @IsIn(['true', 'false']) eligible?: string;
  @IsOptional() @IsIn(['true', 'false']) taxKnown?: string;
  @IsOptional() @IsString() storeId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/** READ-ONLY view of the shadow ledger for the admin. There is deliberately no write route. */
@ApiTags('Admin Platform Ledger')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/platform-ledger')
export class PlatformLedgerController {
  constructor(@InjectModel(PlatformInvoice.name) private readonly ledger: Model<PlatformInvoiceDocument>) {}

  @RequirePermission('billing.manage')
  @Get('summary')
  async summary() {
    const [total, taxUnknown, eligible, byReason] = await Promise.all([
      this.ledger.countDocuments({}),
      this.ledger.countDocuments({ taxKnown: false }),
      this.ledger.countDocuments({ 'routing.eligible': true }),
      this.ledger.aggregate([{ $group: { _id: '$routing.reason', n: { $sum: 1 } } }]),
    ]);
    return { success: true, data: { enabled: isPlatformLedgerEnabled(), total, taxUnknown, eligible, byReason: Object.fromEntries(byReason.map((r: any) => [r._id, r.n])) } };
  }

  @RequirePermission('billing.manage')
  @Get()
  async list(@Query() q: LedgerListQueryDto) {
    const filter: Record<string, any> = {};
    if (q.sourceType) filter.sourceType = q.sourceType;
    if (q.eligible) filter['routing.eligible'] = q.eligible === 'true';
    if (q.taxKnown) filter.taxKnown = q.taxKnown === 'true';
    if (q.storeId) filter['customer.storeId'] = String(q.storeId);
    const page = q.page ?? 1; const limit = q.limit ?? 25;
    const [items, total] = await Promise.all([
      this.ledger.find(filter).sort({ paidAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.ledger.countDocuments(filter),
    ]);
    return { success: true, data: { items, total, page, limit, enabled: isPlatformLedgerEnabled() } };
  }
}
