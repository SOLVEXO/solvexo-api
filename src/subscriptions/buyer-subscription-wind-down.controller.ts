/* eslint-disable prettier/prettier */
import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { BuyerSubscriptionWindDownService } from './buyer-subscription-wind-down.service';

/** Admin-only manual trigger for the (also daily) wind-down of the discontinued buyer VIP plans. */
@ApiTags('Buyer subscription wind-down')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/buyer-subscriptions')
export class BuyerSubscriptionWindDownController {
  constructor(private readonly windDown: BuyerSubscriptionWindDownService) {}

  @Post('wind-down')
  async run() {
    return { success: true, data: await this.windDown.windDown() };
  }
}
