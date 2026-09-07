// import {
//     Controller,
//     Get,
//     Post,
//     Put,
//     Delete,
//     Body,
//     Param,
//     Req,
//     Query
// } from '@nestjs/common';

// import { AuthGuard } from '@nestjs/passport';
// import { UseGuards } from '@nestjs/common';
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// import { Roles } from '../auth/decorators/roles.decorator'
// import { RolesGuard } from '../auth/guards/roles.guard';
// import { checkoutService } from './checkout.service';

// @Controller('api/checkout')
// export class checkoutController {
//     constructor(private readonly checkoutService: checkoutService) { }

//     // checkout.controller.ts

// @Post('addShippingZone')
// async addShippingZone(
//   @Body() body: any
// ) {

//   return this.checkoutService.addShippingZone(body);

// }

// // shipping-zone.controller.ts

// @Get('getShippingZones')
// async getShippingZones() {

//   return this.checkoutService.getShippingZones();

// }

// @UseGuards(JwtAuthGuard, RolesGuard)
// @Post('createCheckout')
//   async createCheckout(
//     @Req() req: any,
//     @Body() body: any
//   ) {
//   const { userId } = req.user;

//     return this.checkoutService.createCheckout(userId, body);
//   }

//   @UseGuards(JwtAuthGuard, RolesGuard)
// @Post('addShippingInCheckout')
//   async addShippingInCheckout(
//     @Req() req: any,
//     @Body() body: any
//   ) {
//   const { userId } = req.user;

//     return this.checkoutService.addShippingInCheckout(userId, body);
//   }

//   @UseGuards(JwtAuthGuard, RolesGuard)
// @Post('changeCheckoutAddress')
//   async changeCheckoutAddress(
//     @Req() req: any,
//     @Body() body: any
//   ) {
//   const { userId } = req.user;

//     return this.checkoutService.changeCheckoutAddress(userId, body);
//   }

//   @UseGuards(JwtAuthGuard, RolesGuard)
// @Get('getCheckout')
// async getCheckout(
//   @Req() req: any,
//   @Query('checkoutId') checkoutId: string,
// ) {
//   const { userId } = req.user;

//   return this.checkoutService.getCheckout(userId, checkoutId);
// }

// }

import {
  Controller,
  Post,
  Delete,
  Param,
  Req,
  UseGuards,
  Get,
  Query,
  Body,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { CheckoutService } from './checkout.service';
import { BillingAccessGuard } from '../platform-plans/guards/billing-access.guard';
import { RequireActiveBilling } from '../platform-plans/decorators/require-active-billing.decorator';

@Controller('api/checkout')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  // Idempotency-Key header (already-proven interceptor, used elsewhere in
  // this codebase) prevents a double-tap/retry from creating two separate
  // checkouts for the same buyer action — previously missing here entirely.
  @UseGuards(JwtAuthGuard, RolesGuard, BillingAccessGuard)
  @Roles('user')
  @RequireActiveBilling()
  @UseInterceptors(IdempotencyInterceptor)
  @Post('create-checkout')
  async createCheckout(@Req() req: any, @Body() body: any) {
    const { userId, storeId } = req.user;
    return this.checkoutService.createCheckout(userId, body, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Delete('delete-checkout/:checkoutId')
  async deleteCheckout(
    @Req() req: any,
    @Param('checkoutId') checkoutId: string,
  ) {
    const { userId } = req.user;
    return this.checkoutService.deleteCheckout(userId, checkoutId);
  }

  @Get('getShippingZones')
  async getShippingZones(@Query('storeId') storeId?: string, @Query('currency') currency?: string) {
    return this.checkoutService.getShippingZones(storeId, currency);
  }

  /** Real live carrier rates (see CheckoutService.getLiveShippingRates's own
   *  doc comment) — an additional option next to the flat zone list above,
   *  `data: null` whenever a live quote isn't available for any reason. */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('live-shipping-rates')
  async getLiveShippingRates(@Req() req: any, @Query('storeId') storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');
    return this.checkoutService.getLiveShippingRates(req.user.userId, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('addShippingInCheckout')
  async addShippingInCheckout(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;

    return this.checkoutService.addShippingInCheckout(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('apply-coupon')
  async applyCoupon(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.checkoutService.applyCoupon(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Delete('remove-coupon/:checkoutId')
  async removeCoupon(@Req() req: any, @Param('checkoutId') checkoutId: string) {
    const { userId } = req.user;
    return this.checkoutService.removeCoupon(userId, { checkoutId });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('apply-gift-card')
  async applyGiftCard(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.checkoutService.applyGiftCard(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Delete('remove-gift-card/:checkoutId')
  async removeGiftCard(@Req() req: any, @Param('checkoutId') checkoutId: string) {
    const { userId } = req.user;
    return this.checkoutService.removeGiftCard(userId, { checkoutId });
  }
}
