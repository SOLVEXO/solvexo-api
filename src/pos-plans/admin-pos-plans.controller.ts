/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminPosPlansService } from './admin-pos-plans.service';
import { CreatePosPlanDto } from './dto/create-pos-plan.dto';
import { UpdatePosPlanDto } from './dto/update-pos-plan.dto';
import { PosPurchaseQueryDto } from './dto/pos-purchase-query.dto';

@ApiTags('Admin POS Plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin')
export class AdminPosPlansController {
  constructor(private readonly adminPosPlansService: AdminPosPlansService) {}

  @Get('pos-plans')
  listPlans() {
    return this.adminPosPlansService.listPlans();
  }

  @Post('pos-plans')
  createPlan(@Body() dto: CreatePosPlanDto) {
    return this.adminPosPlansService.createPlan(dto);
  }

  @Patch('pos-plans/:id')
  updatePlan(@Param('id') id: string, @Body() dto: UpdatePosPlanDto) {
    return this.adminPosPlansService.updatePlan(id, dto);
  }

  @Get('pos-purchases')
  listPurchases(@Query() query: PosPurchaseQueryDto) {
    return this.adminPosPlansService.listPurchases(query);
  }
}
