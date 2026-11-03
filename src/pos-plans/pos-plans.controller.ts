/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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

/** Public (no JWT): the portal's Stripe success page asks whether the webhook has activated the plan yet. */
@ApiTags('POS Plans')
@Controller('api/pos-checkout')
export class PosCheckoutStatusController {
  constructor(private readonly posPlansService: PosPlansService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('session-status')
  sessionStatus(@Query('sessionId') sessionId: string) {
    return this.posPlansService.getCheckoutSessionStatus(sessionId);
  }
}
