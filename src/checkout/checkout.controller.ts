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

import { Controller, Post, Delete, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CheckoutService } from './checkout.service';

@Controller('api/checkout')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('create-checkout')
  async createCheckout(@Req() req: any) {
    const { userId } = req.user;
    return this.checkoutService.createCheckout(userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Delete('delete-checkout/:checkoutId')
  async deleteCheckout(@Req() req: any, @Param('checkoutId') checkoutId: string) {
    const { userId } = req.user;
    return this.checkoutService.deleteCheckout(userId, checkoutId);
  }
}
