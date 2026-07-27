import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Headers,
  UseGuards,
  RawBodyRequest,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaymentService } from './payment.service';

@Controller('api/payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('cod-payment')
  async codPayment(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentService.codPayment(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('initiate-payment')
  async initiatePayment(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentService.initiatePayment(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('status')
  async getPaymentStatus(
    @Req() req: any,
    @Query('checkoutId') checkoutId: string,
  ) {
    const { userId } = req.user;
    return this.paymentService.getPaymentStatus(userId, checkoutId);
  }

  // Stripe calls this directly — no bearer token, trust is the HMAC
  // signature verified in the service via the raw request body.
  @Post('stripe-webhook')
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException(
        'Raw request body unavailable — check rawBody bootstrap config',
      );
    }
    return this.paymentService.stripeWebhook(req.rawBody, signature);
  }
}
