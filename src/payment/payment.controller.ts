import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PaymentProcessingService } from './payment.service'

@Controller('api/payment-processing')
export class PaymentProcessingController {
  constructor(
    private readonly paymentProcessingService: PaymentProcessingService,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('selectPayment')
  async selectPayment(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentProcessingService.selectPayment(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('verifyStripePayment')
  async verifyStripePayment(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentProcessingService.verifyStripePayment(userId, body);
  }
}
