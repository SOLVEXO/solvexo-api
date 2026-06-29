/* eslint-disable prettier/prettier */
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PosService } from './pos.service';
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

@ApiTags('POS')
@ApiBearerAuth()
@Controller('api/pos')
export class PosController {
  constructor(private readonly posService: PosService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPLOYEE MANAGEMENT  (seller only)
  // ═══════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('employees')
  addEmployee(@Req() req: any, @Body() dto: CreateEmployeeDto) {
    return this.posService.addEmployee(req.user.userId, dto);
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('shifts/:storeId/:shiftId')
  removeShift(@Req() req: any, @Param('storeId') storeId: string, @Param('shiftId') shiftId: string) {
    return this.posService.removeShift(req.user.userId, storeId, shiftId);
  }

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
  getActiveSession(@Query('storeId') storeId: string, @Query('registerId') registerId: string) {
    return this.posService.getActiveSession(storeId, registerId);
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
  refundSale(@Req() req: any, @Param('saleId') saleId: string) {
    return this.posService.refundSale(req.user.userId, saleId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete('sales/:saleId/discard')
  discardHeldSale(@Req() req: any, @Param('saleId') saleId: string) {
    return this.posService.discardHeldSale(req.user.userId, saleId);
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
}
