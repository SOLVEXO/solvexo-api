// import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// import { RolesGuard } from '../auth/guards/roles.guard';
// import { PaymentProcessingService } from './payment.service'

// @Controller('api/payment-processing')
// export class PaymentProcessingController {
//   constructor(
//     private readonly paymentProcessingService: PaymentProcessingService,
//   ) {}

//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Post('selectPayment')
//   async selectPayment(@Req() req: any, @Body() body: any) {
//     const { userId } = req.user;
//     return this.paymentProcessingService.selectPayment(userId, body);
//   }

//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Post('verifyStripePayment')
//   async verifyStripePayment(@Req() req: any, @Body() body: any) {
//     const { userId } = req.user;
//     return this.paymentProcessingService.verifyStripePayment(userId, body);
//   }
// }

import { Controller, Post, Body, Req, Headers, UseGuards, RawBodyRequest } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaymentService } from './payment.service';

@Controller('api/payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('initiate-payment')
  async initiatePayment(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentService.initiatePayment(userId, body);
  }

  @Post('stripe-webhook')
  async stripeWebhook(
    @Req() req: RawBodyRequest<any>,
    @Headers('stripe-signature') signature: string,
  ) {
    return this.paymentService.stripeWebhook(req.rawBody, signature);
  }
}
