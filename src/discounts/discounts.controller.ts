/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DiscountsService } from './discounts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { CreateAutomaticDiscountDto } from './dto/create-automatic-discount.dto';
import { UpdateAutomaticDiscountDto } from './dto/update-automatic-discount.dto';

@ApiTags('Discounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('discounts.manage')
@Controller('api/discounts')
export class DiscountsController {
  constructor(private readonly discountsService: DiscountsService) {}

  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateAutomaticDiscountDto) {
    return this.discountsService.createDiscount(actingSellerId(req.user), storeId, dto);
  }

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.discountsService.listDiscounts(actingSellerId(req.user), storeId);
  }

  // Real "Export discounts" — registered BEFORE ':discountId'-shaped routes
  // so the literal 'export' segment isn't swallowed as a param, same
  // static-before-parameterized precedent used elsewhere in this app.
  @Get(':storeId/export')
  async exportCsv(@Req() req: any, @Param('storeId') storeId: string, @Res() res: Response) {
    const csv = await this.discountsService.exportDiscountsCsv(actingSellerId(req.user), storeId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="discounts-${storeId}.csv"`);
    res.send(csv);
  }

  @Patch(':storeId/:discountId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('discountId') discountId: string, @Body() dto: UpdateAutomaticDiscountDto) {
    return this.discountsService.updateDiscount(actingSellerId(req.user), storeId, discountId, dto);
  }

  @Delete(':storeId/:discountId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('discountId') discountId: string) {
    return this.discountsService.deleteDiscount(actingSellerId(req.user), storeId, discountId);
  }
}
