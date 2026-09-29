/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { ManualPaymentsService } from './manual-payments.service';
import { RejectManualPaymentDto } from './dto/reject-manual-payment.dto';

/**
 * Seller-facing review queue for THIS store's manual bank-transfer proofs —
 * replaces the old platform-wide `/api/admin/manual-payments` (money went
 * into the seller's own bank account, per StoreIntegrationsService's
 * 'bank_transfer' provider, so it's the seller who confirms it arrived, not
 * Solvexo). Same guard/ownership shape as SellerIntegrationsController;
 * gated on `orders.record_payment` since approving a proof is exactly that —
 * recording that an order's payment was received.
 */
@ApiTags('Seller — Manual Bank Transfer Verification')
@ApiBearerAuth('accessToken')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('orders.record_payment')
@Controller('api/store/:storeId/manual-payments')
export class SellerManualPaymentsController {
  constructor(private readonly manualPaymentsService: ManualPaymentsService) {}

  @Get()
  async listQueue(@Param('storeId') storeId: string, @Req() req: any, @Query() query: any) {
    const data = await this.manualPaymentsService.sellerListQueue(storeId, actingSellerId(req.user), query);
    return { success: true, data };
  }

  @Get(':proofId')
  async getById(@Param('storeId') storeId: string, @Param('proofId') proofId: string, @Req() req: any) {
    const data = await this.manualPaymentsService.sellerGetById(storeId, actingSellerId(req.user), proofId);
    return { success: true, data };
  }

  @Patch(':proofId/approve')
  async approve(@Req() req: any, @Param('storeId') storeId: string, @Param('proofId') proofId: string) {
    const data = await this.manualPaymentsService.sellerApprove(storeId, actingSellerId(req.user), proofId, req.ip, req.headers['user-agent']);
    return { success: true, data };
  }

  @Patch(':proofId/reject')
  async reject(@Req() req: any, @Param('storeId') storeId: string, @Param('proofId') proofId: string, @Body() dto: RejectManualPaymentDto) {
    const data = await this.manualPaymentsService.sellerReject(storeId, actingSellerId(req.user), proofId, dto.reason, req.ip, req.headers['user-agent']);
    return { success: true, data };
  }
}
