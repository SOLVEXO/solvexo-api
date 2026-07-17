/* eslint-disable prettier/prettier */
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PosService } from './pos.service';
import { StoreLocationService } from './store-location.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { PinLoginDto } from './dto/pin-login.dto';
import { OpenSessionDto } from './dto/open-session.dto';
import { CloseSessionDto } from './dto/close-session.dto';
import { CreateSaleDto } from './dto/create-sale.dto';
import { CompleteSaleDto } from './dto/complete-sale.dto';
import { CashAdjustmentDto } from './dto/cash-adjustment.dto';
import { RefundSaleDto } from './dto/refund-sale.dto';
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

// Class-level FeatureFlagGuard only (not JwtAuthGuard) — pin-login runs before
// a POS employee has a JWT, so the platform-wide posMode kill switch has to
// apply independently of the per-route auth guards below.
@ApiTags('POS')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@RequireFeature('posMode')
@Controller('api/pos')
export class PosController {
  constructor(
    private readonly posService: PosService,
    private readonly storeLocationService: StoreLocationService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // MULTI-LOCATION POS (seller only) — physical branches under one store
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('locations/:storeId')
  createLocation(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateStoreLocationDto) {
    return this.storeLocationService.createLocation(req.user.userId, storeId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('locations/:storeId')
  listLocations(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeLocationService.listLocations(req.user.userId, storeId);
  }

  // combined "all branches" comparison — must be before the parameterized :locationId route
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('locations/:storeId/overview')
  getLocationsOverview(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.storeLocationService.getLocationsOverview(req.user.userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('locations/:storeId/:locationId')
  getLocationById(@Req() req: any, @Param('storeId') storeId: string, @Param('locationId') locationId: string) {
    return this.storeLocationService.getLocationById(req.user.userId, storeId, locationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('locations/:storeId/:locationId')
  updateLocation(@Req() req: any, @Param('storeId') storeId: string, @Param('locationId') locationId: string, @Body() dto: UpdateStoreLocationDto) {
    return this.storeLocationService.updateLocation(req.user.userId, storeId, locationId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('locations/:storeId/:locationId')
  archiveLocation(@Req() req: any, @Param('storeId') storeId: string, @Param('locationId') locationId: string, @Query('force') force: string) {
    return this.storeLocationService.archiveLocation(req.user.userId, storeId, locationId, force === 'true');
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

  @UseGuards(JwtAuthGuard)
  @Post('pin-login')
  pinLogin(@Body() dto: PinLoginDto) {
    return this.posService.pinLogin(dto);
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('products/search')
  searchProducts(@Req() req: any, @Query('storeId') storeId: string, @Query('q') q: string) {
    return this.posService.searchProducts(req.user.userId, storeId, q);
  }

  // must be after /products/search — parameterized route last
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('products/:storeId')
  getPosProducts(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.posService.getPosProducts(req.user.userId, storeId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSIONS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('sessions/open')
  openSession(@Req() req: any, @Body() dto: OpenSessionDto) {
    return this.posService.openSession(req.user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('sessions/close')
  closeSession(@Req() req: any, @Body() dto: CloseSessionDto) {
    return this.posService.closeSession(req.user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sessions/active')
  getActiveSession(@Req() req: any, @Query('storeId') storeId: string, @Query('registerId') registerId: string) {
    return this.posService.getActiveSession(req.user.userId, storeId, registerId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sessions/history')
  getSessionHistory(@Req() req: any, @Query('storeId') storeId: string, @Query() query: any) {
    return this.posService.getSessionHistory(req.user.userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('sessions/:sessionId/cash-adjustment')
  cashInOut(@Req() req: any, @Param('sessionId') sessionId: string, @Body() dto: CashAdjustmentDto) {
    return this.posService.cashInOut(req.user.userId, sessionId, dto);
  }

  // must be after static /sessions/* routes
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sessions/:sessionId/report')
  getSessionReport(@Req() req: any, @Param('sessionId') sessionId: string) {
    return this.posService.getSessionReport(req.user.userId, sessionId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SALES  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('sales')
  createSale(@Req() req: any, @Body() dto: CreateSaleDto) {
    return this.posService.createSale(req.user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sales/held')
  getHeldSales(@Req() req: any, @Query('storeId') storeId: string, @Query('sessionId') sessionId?: string) {
    return this.posService.getHeldSales(req.user.userId, storeId, sessionId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sales')
  getSales(@Req() req: any, @Query() query: any) {
    return this.posService.getSales(req.user.userId, query);
  }

  // must be after /sales/held and GET /sales — parameterized routes last
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('sales/:saleId')
  getSaleById(@Req() req: any, @Param('saleId') saleId: string) {
    return this.posService.getSaleById(req.user.userId, saleId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('sales/:saleId/complete')
  completeSale(@Req() req: any, @Param('saleId') saleId: string, @Body() dto: CompleteSaleDto) {
    return this.posService.completeSale(req.user.userId, saleId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('sales/:saleId/refund')
  refundSale(@Req() req: any, @Param('saleId') saleId: string, @Body() dto: RefundSaleDto) {
    return this.posService.refundSale(req.user.userId, saleId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('sales/:saleId/discard')
  discardHeldSale(@Req() req: any, @Param('saleId') saleId: string) {
    return this.posService.discardHeldSale(req.user.userId, saleId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTER CRUD EXTENSIONS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('registers/:storeId')
  listRegisters(@Req() req: any, @Param('storeId') storeId: string) {
    return this.posService.listRegisters(req.user.userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('shifts/:storeId')
  listShifts(@Req() req: any, @Param('storeId') storeId: string) {
    return this.posService.listShifts(req.user.userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('products/barcode/:storeId/:barcode')
  getProductByBarcode(@Req() req: any, @Param('storeId') storeId: string, @Param('barcode') barcode: string) {
    return this.posService.getProductByBarcode(req.user.userId, storeId, barcode);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SALES EXTENSIONS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('sales/:saleId/void')
  voidSale(@Req() req: any, @Param('saleId') saleId: string, @Body() dto: { reason?: string; actingEmployeeId?: string }) {
    return this.posService.voidSale(req.user.userId, saleId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('sales/:saleId/items')
  editHeldSaleItems(@Req() req: any, @Param('saleId') saleId: string, @Body() dto: UpdateSaleItemsDto) {
    return this.posService.editHeldSaleItems(req.user.userId, saleId, dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPORTS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('reports/daily')
  getDailyReport(@Req() req: any, @Query('storeId') storeId: string, @Query() query: any) {
    return this.posService.getDailyReport(req.user.userId, storeId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('reports/range')
  getDateRangeReport(@Req() req: any, @Query('storeId') storeId: string, @Query() query: any) {
    return this.posService.getDateRangeReport(req.user.userId, storeId, query);
  }

  // static /reports/daily/export before parameterized /reports/:x
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('reports/daily/export')
  async exportDailyReport(@Req() req: any, @Query('storeId') storeId: string, @Query() query: any, @Res() res: Response) {
    const csv = await this.posService.exportDailyReportCsv(req.user.userId, storeId, query);
    const filename = `pos-report-${query.date ?? new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('reports/register/:registerId')
  getRegisterReport(@Req() req: any, @Param('registerId') registerId: string, @Query() query: any) {
    return this.posService.getRegisterReport(req.user.userId, registerId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('reports/employee/:employeeId')
  getEmployeeReport(@Req() req: any, @Param('employeeId') employeeId: string, @Query() query: any) {
    return this.posService.getEmployeeReport(req.user.userId, employeeId, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POS SETTINGS  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('audit-logs/:storeId')
  getAuditLogs(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.posService.getAuditLogs(req.user.userId, storeId, query);
  }
}
