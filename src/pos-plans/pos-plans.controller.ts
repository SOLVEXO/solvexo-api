/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PosPlansService } from './pos-plans.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

@ApiTags('POS Plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api')
export class PosPlansController {
  constructor(private readonly posPlansService: PosPlansService) {}

  @Get('pos-plans')
  getPlans() {
    return this.posPlansService.getActivePlans();
  }

  @Get('pos-subscriptions/:storeId')
  getStatus(@Req() req: any, @Param('storeId') storeId: string) {
    return this.posPlansService.getStatus(storeId, req.user.userId);
  }

  @Post('pos-subscriptions/:storeId/checkout-session')
  createCheckoutSession(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateCheckoutSessionDto) {
    return this.posPlansService.createCheckoutSession(storeId, req.user.userId, dto);
  }
}
