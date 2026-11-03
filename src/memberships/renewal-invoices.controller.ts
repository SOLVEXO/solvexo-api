/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { pageOf } from '../common/paging';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { privateUploadFileFilter } from '../upload/upload-file-validation';
import { DatabaseService } from '../database/databaseservice';
import { MAX_PROOF_BYTES, RenewalInvoicesService } from './renewal-invoices.service';

class RejectDto { @IsString() @IsNotEmpty() @MaxLength(300) reason: string; }
class RemindDto { @IsArray() ids: string[]; }
class ProofDto { @IsOptional() @IsString() @MaxLength(100) reference?: string; @IsOptional() @IsString() @MaxLength(100) senderName?: string; }

const PROOF_UPLOAD = { storage: memoryStorage(), limits: { fileSize: MAX_PROOF_BYTES, files: 1 }, fileFilter: privateUploadFileFilter };

/** Buyer: own renewal invoices, payment instructions, receipt upload. */
@ApiTags('Memberships: renewal invoices (buyer)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@Controller('api/memberships/me/invoices')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class BuyerRenewalInvoicesController {
  constructor(private readonly svc: RenewalInvoicesService) {}
  private sid = (req: any, q?: string) => resolveBuyerStoreScope(req.user.storeId, q);

  @Get()
  list(@Req() req: any, @Query('storeId') q: string) { return this.svc.listMine(this.sid(req, q), req.user.userId); }

  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post(':id/proof')
  @UseInterceptors(FileInterceptor('file', PROOF_UPLOAD))
  proof(@Req() req: any, @Query('storeId') q: string, @Param('id') id: string, @Body() dto: ProofDto, @UploadedFile() file?: Express.Multer.File) {
    return this.svc.submitProof(this.sid(req, q), req.user.userId, id, file, dto);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':id/proof-url')
  proofUrl(@Req() req: any, @Query('storeId') q: string, @Param('id') id: string) { return this.svc.proofUrlForBuyer(this.sid(req, q), req.user.userId, id); }
}

/** Seller / staff with members.manage: the "payments to confirm" queue. */
@ApiTags('Memberships: renewal invoices (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('members.manage')
@Controller('api/memberships/store/:storeId/invoices')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SellerRenewalInvoicesController {
  constructor(private readonly svc: RenewalInvoicesService, private readonly db: DatabaseService) {}
  private own = (req: any, storeId: string) => verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
  private by = (req: any) => String(req.user.userId ?? req.user.staffId ?? 'seller');

  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string, @Query('planId') planId?: string, @Query('dueBefore') dueBefore?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    await this.own(req, storeId);
    return this.svc.list(storeId, { status, planId, dueBefore }, pageOf(page, limit));
  }

  @Post('remind')
  async remind(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: RemindDto) { await this.own(req, storeId); return this.svc.remind(storeId, dto.ids, this.by(req)); }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':id/proof-url')
  async proofUrl(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) { await this.own(req, storeId); return this.svc.proofUrlForSeller(storeId, id); }

  @Post(':id/approve')
  async approve(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) { await this.own(req, storeId); return this.svc.approve(storeId, id, this.by(req)); }

  @Post(':id/reject')
  async reject(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: RejectDto) { await this.own(req, storeId); return this.svc.reject(storeId, id, this.by(req), dto.reason); }

  @Post(':id/void')
  async voidIt(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) { await this.own(req, storeId); return this.svc.voidInvoice(storeId, id, this.by(req)); }
}
