import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    Req,
    Query
} from '@nestjs/common';

import { AuthGuard } from '@nestjs/passport';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator'
import { RolesGuard } from '../auth/guards/roles.guard'; 
import { checkoutService } from './checkout.service';

@Controller('api/checkout')
export class checkoutController {
    constructor(private readonly checkoutService: checkoutService) { }

    // checkout.controller.ts

@Post('addShippingZone')
async addShippingZone(
  @Body() body: any
) {

  return this.checkoutService.addShippingZone(body);

}

// shipping-zone.controller.ts

@Get('getShippingZones')
async getShippingZones() {

  return this.checkoutService.getShippingZones();

}

@UseGuards(JwtAuthGuard, RolesGuard)
@Post('createCheckout')
  async createCheckout(
    @Req() req: any,
    @Body() body: any
  ) {
  const { userId } = req.user;

    return this.checkoutService.createCheckout(userId, body);
  }

}