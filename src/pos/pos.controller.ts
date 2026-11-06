/* eslint-disable prettier/prettier */
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req, Res, UseGuards, Headers, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv } from '../common/bulk-import/bulk-import.util';
import { LOCATION_IMPORT_COLUMNS } from './store-locations-bulk-import';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PosService } from './pos.service';
import { PosDeviceService } from './pos-device.service';
import { PosReceiptService } from './pos-receipt.service';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { InventoryService } from '../inventory/inventory.service';
import { PosPlansService } from '../pos-plans/pos-plans.service';
import { KybGateService } from '../kyb/kyb-gate.service';
import { StoreLocationService } from './store-location.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PosAuthGuard, RequireManagerPin } from './guards/pos-auth.guard';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { PinLoginDto } from './dto/pin-login.dto';
import { OpenSessionDto } from './dto/open-session.dto';
import { CloseSessionDto } from './dto/close-session.dto';
import { CreateSaleDto } from './dto/create-sale.dto';
import { QuoteSaleDto } from './dto/quote-sale.dto';
import { CompleteSaleDto } from './dto/complete-sale.dto';
import { CashAdjustmentDto } from './dto/cash-adjustment.dto';
import { RefundSaleDto } from './dto/refund-sale.dto';
import { PosCatalogService } from './pos-catalog.service';
import { AdjustCatalogStockDto, UpdateCatalogVariantDto } from './dto/catalog.dto';
import { ForceCloseSessionDto } from './dto/force-close-session.dto';
import { UpdateRegisterDto } from './dto/update-register.dto';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { ResetPinDto } from './dto/reset-pin.dto';
import { UpdateSaleItemsDto } from './dto/update-sale-items.dto';
import { UpdatePosSettingsDto } from './dto/update-pos-settings.dto';
import { CreateStoreLocationDto } from './dto/create-store-location.dto';
import { UpdateStoreLocationDto } from './dto/update-store-location.dto';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';

@ApiTags('POS')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos')
export class PosController {
  constructor(
    private readonly posService: PosService,
    private readonly storeLocationService: StoreLocationService,
    private readonly devices: PosDeviceService,
    private readonly inventoryService: InventoryService,
    private readonly posPlansService: PosPlansService,
    private readonly kybGate: KybGateService,
    private readonly receipts: PosReceiptService,
    private readonly catalog: PosCatalogService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // DEVICES (5D) — register/list/revoke need the OWNER's own session (re-auth in the app);
  // `devices/me` is the device checking itself.
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('devices/me')
  async deviceMe(@Req() req: any) {
    // Reaching here means the guard accepted the token: it is a live, un-revoked device (or an owner/staff session).
    return { success: true, data: req.user.posDevice ?? null };
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('devices/me/sign-out')
  deviceSignOut(@Req() req: any) {
    // Only a device can retire itself this way (an owner session has no device to retire).
    if (!req.user.posDevice) throw new ForbiddenException('Only a registered device can sign itself out');
    return this.devices.signOutSelf(req.user.posDevice.deviceId, req.user.posDevice.storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('devices')
  registerDevice(@Req() req: any, @Body() dto: RegisterDeviceDto) {
    return this.devices.register(req.user.userId, dto, req.ip);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('devices/:storeId')
  listDevices(@Req() req: any, @Param('storeId') storeId: string) {
    return this.devices.list(req.user.userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('devices/:storeId/:deviceId/revoke')
  revokeDevice(@Req() req: any, @Param('storeId') storeId: string, @Param('deviceId') deviceId: string) {
    return this.devices.revoke(req.user.userId, storeId, deviceId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // READ-ONLY views the till needs that live in other modules (their own routes reject device tokens)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('inventory/:storeId')
  posInventory(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.inventoryService.getStoreInventory(req.user.userId, storeId, query);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('inventory/:storeId/low-stock')
  posLowStock(@Req() req: any, @Param('storeId') storeId: string) {
    return this.inventoryService.getLowStockSummary(req.user.userId, storeId);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('subscription/:storeId')
  async posSubscription(@Req() req: any, @Param('storeId') storeId: string) {
    const res: any = await this.posPlansService.getStatus(storeId, req.user.userId);
    // G2.2 (additive): lets the app hide the QR option for a store that is not KYB-verified. Old builds ignore the field.
    return { ...res, data: { ...res.data, digitalPaymentsEnabled: await this.kybGate.isEnabled(storeId) } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MULTI-LOCATION POS (seller only) — physical branches under one store
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.locations.manage')
  @Post('locations/:storeId')
  createLocation(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateStoreLocationDto) {
    return this.storeLocationService.createLocation(actingSellerId(req.user), storeId, dto);
  }

  // CSV import — static segments, declared before `locations/:storeId/:locationId`.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.locations.manage')
  @Get('locations/:storeId/import-template')
  importLocationsTemplate() {
    return buildTemplatePayload('locations-import-template.csv', LOCATION_IMPORT_COLUMNS);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.locations.manage')
  @Post('locations/:storeId/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  importLocations(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any) {
    return this.storeLocationService.importLocationsCsv(actingSellerId(req.user), storeId, readUploadedCsv(file));
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.locations.manage')
  @Get('locations/:storeId')
  listLocations(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeLocationService.listLocations(actingSellerId(req.user), storeId);
  }

  // combined "all branches" comparison — must be before the parameterized :locationId route
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.locations.manage')
  @Get('locations/:storeId/overview')
  getLocationsOverview(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.storeLocationService.getLocationsOverview(actingSellerId(req.user), storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.locations.manage')
  @Get('locations/:storeId/:locationId')
  getLocationById(@Req() req: any, @Param('storeId') storeId: string, @Param('locationId') locationId: string) {
    return this.storeLocationService.getLocationById(actingSellerId(req.user), storeId, locationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.locations.manage')
  @Patch('locations/:storeId/:locationId')
  updateLocation(@Req() req: any, @Param('storeId') storeId: string, @Param('locationId') locationId: string, @Body() dto: UpdateStoreLocationDto) {
    return this.storeLocationService.updateLocation(actingSellerId(req.user), storeId, locationId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.locations.manage')
  @Delete('locations/:storeId/:locationId')
  archiveLocation(@Req() req: any, @Param('storeId') storeId: string, @Param('locationId') locationId: string, @Query('force') force: string) {
    return this.storeLocationService.archiveLocation(actingSellerId(req.user), storeId, locationId, force === 'true');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPLOYEE MANAGEMENT  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('employees')
  addEmployee(@Req() req: any, @Body() dto: CreateEmployeeDto) {
    return this.posService.addEmployee(req.user.userId, dto, req.ip, req.headers['user-agent']);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('employees/:storeId')
  getEmployees(@Req() req: any, @Param('storeId') storeId: string) {
    return this.posService.getEmployees(req.user.userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('employees/:employeeId')
  updateEmployee(@Req() req: any, @Param('employeeId') employeeId: string, @Body() dto: UpdateEmployeeDto) {
    return this.posService.updateEmployee(req.user.userId, employeeId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('employees/:employeeId')
  removeEmployee(@Req() req: any, @Param('employeeId') employeeId: string) {
    return this.posService.removeEmployee(req.user.userId, employeeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PIN LOGIN  (any authenticated user — POS terminal uses seller JWT)
  // ═══════════════════════════════════════════════════════════════════════════

  // Seller (owner) or staff of that store only — a buyer/admin token has no
  // business minting POS employee sessions; the service additionally pins the
  // caller to the target store.
  // NOT entitlement-gated: a cashier must always be able to PIN in — to close the shift, count
  // the drawer, refund or look at reports — even after the plan lapses. Selling, holding and
  // opening a session are what the plan gates.
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller', 'staff')
  @Post('pin-login')
  pinLogin(@Req() req: any, @Body() dto: PinLoginDto) {
    return this.posService.pinLogin(dto, { userId: req.user.userId, role: req.user.role, storeId: req.user.storeId, sellerId: req.user.sellerId, deviceId: req.user.posDevice?.deviceId ?? null });
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('pin-logout')
  pinLogout(@Req() req: any, @Body('storeId') storeId: string, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.posService.pinLogout(req.user.userId, storeId, employeeToken);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTER MANAGEMENT  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('registers/:storeId')
  addRegister(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.posService.addRegister(req.user.userId, storeId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('registers/:storeId/:registerId')
  removeRegister(@Req() req: any, @Param('storeId') storeId: string, @Param('registerId') registerId: string) {
    return this.posService.removeRegister(req.user.userId, storeId, registerId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHIFT MANAGEMENT  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('shifts/:storeId')
  addShift(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any) {
    return this.posService.addShift(req.user.userId, storeId, body);
  }

  // Deletion is handled by deleteShift() below (supports ?force=true and the
  // assigned-employee guard) — kept as the single handler for this route.

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCT SEARCH & BROWSE  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard)
  @Roles('seller')
  @Get('products/search')
  searchProducts(@Req() req: any, @Query('storeId') storeId: string, @Query('q') q: string) {
    return this.posService.searchProducts(req.user.userId, storeId, q);
  }

  // must be after /products/search — parameterized route last
  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard)
  @Roles('seller')
  @Get('products/:storeId')
  getPosProducts(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.posService.getPosProducts(req.user.userId, storeId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSIONS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('sessions/open')
  openSession(@Req() req: any, @Body() dto: OpenSessionDto) {
    return this.posService.openSession(req.user.userId, dto);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('sessions/close')
  closeSession(@Req() req: any, @Body() dto: CloseSessionDto, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.posService.closeSession(req.user.userId, dto, employeeToken);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sessions/active')
  getActiveSession(@Req() req: any, @Query('storeId') storeId: string, @Query('registerId') registerId: string) {
    return this.posService.getActiveSession(req.user.userId, storeId, registerId);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sessions/history')
  getSessionHistory(@Req() req: any, @Query('storeId') storeId: string, @Query() query: any) {
    return this.posService.getSessionHistory(req.user.userId, storeId, query);
  }

  // Cash in/out is drawer reconciliation (manager-token only), so it stays available when the plan is
  // inactive, alongside session close.
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('sessions/:sessionId/cash-adjustment')
  cashInOut(@Req() req: any, @Param('sessionId') sessionId: string, @Body() dto: CashAdjustmentDto, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.posService.cashInOut(req.user.userId, sessionId, dto, employeeToken);
  }

  // must be after static /sessions/* routes
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sessions/:sessionId/report')
  getSessionReport(@Req() req: any, @Param('sessionId') sessionId: string) {
    return this.posService.getSessionReport(req.user.userId, sessionId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SALES  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard)
  @Roles('seller')
  // Gated by the POS plan only (PosEntitlementGuard) — the platform-plan trial guard
  // (`BillingAccessGuard`/`blockDuringTrial`) no longer applies to POS routes. Enforced
  // here at the backend, so it is identical for the web POS terminal and the native app.
  // Idempotent on both the body `idempotencyKey` (unique index, survives header loss)
  // and the `Idempotency-Key` header (replays the first response on an exact retry).
  @UseInterceptors(IdempotencyInterceptor)
  @Post('sales')
  createSale(@Req() req: any, @Body() dto: CreateSaleDto, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.posService.createSale(req.user.userId, dto, employeeToken);
  }

  // Price a cart without selling it — gated exactly like selling (it is part of ringing a sale), no side effects.
  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard)
  @Roles('seller')
  @Post('sales/quote')
  quoteSale(@Req() req: any, @Body() dto: QuoteSaleDto) {
    return this.posService.quoteSale(req.user.userId, dto);
  }

  // Offline-sync review queue — static segments, declared before the parameterised `sales/:saleId` routes.
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sales/needs-review')
  getSalesNeedingReview(@Req() req: any, @Query('storeId') storeId: string) {
    return this.posService.getSalesNeedingReview(req.user.userId, storeId);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('sales/:saleId/resolve-review')
  resolveSaleReview(@Req() req: any, @Param('saleId') saleId: string, @Body('note') note: string, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.posService.resolveSaleReview(req.user.userId, saleId, note, employeeToken);
  }

  // A manager gives up on a queued offline sale that can never sync — recorded in the audit log (reason required).
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('offline-discards')
  recordOfflineDiscard(@Req() req: any, @Body() body: { storeId: string; idempotencyKey: string; reason: string; summary?: Record<string, any> }, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.posService.recordOfflineDiscard(req.user.userId, body, employeeToken);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sales/held')
  getHeldSales(@Req() req: any, @Query('storeId') storeId: string, @Query('sessionId') sessionId?: string) {
    return this.posService.getHeldSales(req.user.userId, storeId, sessionId);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sales')
  getSales(@Req() req: any, @Query() query: any) {
    return this.posService.getSales(req.user.userId, query);
  }

  // must be after /sales/held and GET /sales — parameterized routes last
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sales/:saleId')
  getSaleById(@Req() req: any, @Param('saleId') saleId: string) {
    return this.posService.getSaleById(req.user.userId, saleId);
  }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('sales/:saleId/complete')
  completeSale(@Req() req: any, @Param('saleId') saleId: string, @Body() dto: CompleteSaleDto, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.posService.completeSale(req.user.userId, saleId, dto, employeeToken);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('sales/:saleId/refund')
  refundSale(@Req() req: any, @Param('saleId') saleId: string, @Body() dto: RefundSaleDto, @Headers('x-pos-employee-token') employeeToken?: string, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.posService.refundSale(req.user.userId, saleId, dto, employeeToken, idempotencyKey);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Delete('sales/:saleId/discard')
  discardHeldSale(@Req() req: any, @Param('saleId') saleId: string, @Body() body?: { reason?: string; reasonCode?: string }, @Query('reason') reasonQuery?: string, @Query('reasonCode') reasonCodeQuery?: string, @Headers('x-pos-employee-token') employeeToken?: string) {
    // the reason may come in the body or the query string (DELETE bodies are dropped by some HTTP clients); old builds send none
    return this.posService.discardHeldSale(req.user.userId, saleId, { reason: body?.reason ?? reasonQuery, reasonCode: body?.reasonCode ?? reasonCodeQuery, employeeToken });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTER CRUD EXTENSIONS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('registers/:storeId')
  listRegisters(@Req() req: any, @Param('storeId') storeId: string) {
    return this.posService.listRegisters(req.user.userId, storeId);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('registers/:storeId/:registerId')
  getRegisterById(@Req() req: any, @Param('storeId') storeId: string, @Param('registerId') registerId: string) {
    return this.posService.getRegisterById(req.user.userId, storeId, registerId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('registers/:storeId/:registerId')
  updateRegister(@Req() req: any, @Param('storeId') storeId: string, @Param('registerId') registerId: string, @Body() dto: UpdateRegisterDto) {
    return this.posService.updateRegister(req.user.userId, storeId, registerId, dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHIFT CRUD EXTENSIONS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('shifts/:storeId')
  listShifts(@Req() req: any, @Param('storeId') storeId: string) {
    return this.posService.listShifts(req.user.userId, storeId);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('shifts/:storeId/:shiftId')
  getShiftById(@Req() req: any, @Param('storeId') storeId: string, @Param('shiftId') shiftId: string) {
    return this.posService.getShiftById(req.user.userId, storeId, shiftId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('shifts/:storeId/:shiftId')
  updateShift(@Req() req: any, @Param('storeId') storeId: string, @Param('shiftId') shiftId: string, @Body() dto: UpdateShiftDto) {
    return this.posService.updateShift(req.user.userId, storeId, shiftId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('shifts/:storeId/:shiftId')
  deleteShift(@Req() req: any, @Param('storeId') storeId: string, @Param('shiftId') shiftId: string, @Query('force') force: string) {
    return this.posService.deleteShift(req.user.userId, storeId, shiftId, force === 'true');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPLOYEE EXTENSIONS  (seller only) — storeId-scoped routes
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('employees/:storeId/:employeeId')
  getEmployeeById(@Req() req: any, @Param('storeId') storeId: string, @Param('employeeId') employeeId: string) {
    return this.posService.getEmployeeById(req.user.userId, storeId, employeeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('employees/:storeId/:employeeId')
  updateEmployeeV2(@Req() req: any, @Param('storeId') storeId: string, @Param('employeeId') employeeId: string, @Body() dto: UpdateEmployeeDto) {
    return this.posService.updateEmployeeV2(req.user.userId, storeId, employeeId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('employees/:storeId/:employeeId')
  removeEmployeeV2(@Req() req: any, @Param('storeId') storeId: string, @Param('employeeId') employeeId: string) {
    return this.posService.removeEmployeeV2(req.user.userId, storeId, employeeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('employees/:storeId/:employeeId/reset-pin')
  resetPin(@Req() req: any, @Param('storeId') storeId: string, @Param('employeeId') employeeId: string, @Body() dto: ResetPinDto) {
    return this.posService.resetPin(req.user.userId, storeId, employeeId, dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSION EXTENSIONS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('sessions/:sessionId/force-close')
  forceCloseSession(@Req() req: any, @Param('sessionId') sessionId: string, @Body() dto: ForceCloseSessionDto) {
    return this.posService.forceCloseSession(req.user.userId, sessionId, dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCT BARCODE LOOKUP  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard)
  @Roles('seller')
  @Get('products/barcode/:storeId/:barcode')
  getProductByBarcode(@Req() req: any, @Param('storeId') storeId: string, @Param('barcode') barcode: string) {
    return this.posService.getProductByBarcode(req.user.userId, storeId, barcode);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SALES EXTENSIONS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('sales/:saleId/void')
  voidSale(@Req() req: any, @Param('saleId') saleId: string, @Body() dto: { reason?: string; reasonCode?: string }, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.posService.voidSale(req.user.userId, saleId, dto, employeeToken);
  }

  // ── G2.6 POS catalog edits (D3): a manager's PIN session; audited with before/after; the storefront reads the same documents ──
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('catalog/:storeId/variants/:variantId')
  updateCatalogVariant(@Req() req: any, @Param('storeId') storeId: string, @Param('variantId') variantId: string, @Body() dto: UpdateCatalogVariantDto, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.catalog.updateVariant(req.user.userId, storeId, variantId, dto, employeeToken);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('catalog/:storeId/variants/:variantId/stock')
  adjustCatalogStock(@Req() req: any, @Param('storeId') storeId: string, @Param('variantId') variantId: string, @Body() dto: AdjustCatalogStockDto, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.catalog.adjustStock(req.user.userId, storeId, variantId, dto, employeeToken);
  }

  /**
   * G2.6 Home dashboard (role-based): a cashier gets only their own open shift; a manager / owner get the store for today, plus low stock
   * and what needs attention. Read-only, so it stays available when the POS plan has lapsed (like the reports).
   */
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('dashboard/:storeId')
  async dashboard(@Req() req: any, @Param('storeId') storeId: string, @Headers('x-pos-employee-token') employeeToken?: string) {
    const res: any = await this.posService.getDashboard(req.user.userId, storeId, employeeToken);
    if (res.data.role !== 'cashier') {
      const low: any = await this.inventoryService.getLowStockSummary(req.user.userId, storeId).catch(() => null);
      res.data.lowStock = low?.data ?? null;
    } else {
      res.data.lowStock = null; // a cashier does not see store-wide stock figures
    }
    return res;
  }

  /** G2.5: the tax invoice and every credit note of a sale (for the till's order detail / print / share). */
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sales/:saleId/documents')
  saleDocuments(@Req() req: any, @Param('saleId') saleId: string) {
    return this.receipts.documentsOf(req.user.userId, saleId);
  }

  /** G2.4 digital receipt link (same link every time until a manager revokes it). Any till of the store may ask; it is not a plan-gated action. */
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sales/:saleId/receipt-link')
  receiptLink(@Req() req: any, @Param('saleId') saleId: string) {
    return this.receipts.getLink(req.user.userId, saleId);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @RequireManagerPin()
  @Post('sales/:saleId/receipt-link/revoke')
  async revokeReceiptLink(@Req() req: any, @Param('saleId') saleId: string, @Headers('x-pos-employee-token') employeeToken?: string) {
    const m = await this.posService.requireManagerEmployee(employeeToken, req.user.storeId ?? (await this.posService.storeIdOfSale(saleId)), 'revoke a receipt link');
    return this.receipts.revoke(req.user.userId, saleId, m.employeeId);
  }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard)
  @Roles('seller')
  @Patch('sales/:saleId/items')
  editHeldSaleItems(@Req() req: any, @Param('saleId') saleId: string, @Body() dto: UpdateSaleItemsDto, @Headers('x-pos-employee-token') employeeToken?: string) {
    return this.posService.editHeldSaleItems(req.user.userId, saleId, dto, employeeToken);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SEARCH  (seller only) — scoped to this store's own buyers
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('customers/:storeId/search')
  searchStoreCustomers(@Req() req: any, @Param('storeId') storeId: string, @Query('q') q: string) {
    return this.posService.searchStoreCustomers(req.user.userId, storeId, q);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPORTS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard)
  @RequireManagerPin()
  @Roles('seller')
  @Get('reports/daily')
  getDailyReport(@Req() req: any, @Query('storeId') storeId: string, @Query() query: any) {
    return this.posService.getDailyReport(req.user.userId, storeId, query);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @RequireManagerPin()
  @Roles('seller')
  @Get('reports/range')
  getDateRangeReport(@Req() req: any, @Query('storeId') storeId: string, @Query() query: any) {
    return this.posService.getDateRangeReport(req.user.userId, storeId, query);
  }

  // static /reports/daily/export before parameterized /reports/:x
  @UseGuards(PosAuthGuard, RolesGuard)
  @RequireManagerPin()
  @Roles('seller')
  @Get('reports/daily/export')
  async exportDailyReport(@Req() req: any, @Query('storeId') storeId: string, @Query() query: any, @Res() res: Response) {
    const csv = await this.posService.exportDailyReportCsv(req.user.userId, storeId, query);
    const filename = `pos-report-${query.date ?? new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @RequireManagerPin()
  @Roles('seller')
  @Get('reports/register/:registerId')
  getRegisterReport(@Req() req: any, @Param('registerId') registerId: string, @Query() query: any) {
    return this.posService.getRegisterReport(req.user.userId, registerId, query);
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @RequireManagerPin()
  @Roles('seller')
  @Get('reports/employee/:employeeId')
  getEmployeeReport(@Req() req: any, @Param('employeeId') employeeId: string, @Query() query: any) {
    return this.posService.getEmployeeReport(req.user.userId, employeeId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POS SETTINGS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('settings/:storeId')
  getPosSettings(@Req() req: any, @Param('storeId') storeId: string) {
    return this.posService.getPosSettings(req.user.userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('settings/:storeId')
  updatePosSettings(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdatePosSettingsDto) {
    return this.posService.updatePosSettings(req.user.userId, storeId, dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUDIT LOGS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(PosAuthGuard, RolesGuard)
  @RequireManagerPin()
  @Roles('seller')
  @Get('audit-logs/:storeId')
  getAuditLogs(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.posService.getAuditLogs(req.user.userId, storeId, query);
  }
}
