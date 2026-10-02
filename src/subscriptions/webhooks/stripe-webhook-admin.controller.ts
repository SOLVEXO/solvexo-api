/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { StripeWebhookService } from './stripe-webhook.service';

/** Admin dead-letter view + replay for Stripe webhook events (platform infrastructure, not tied to any one feature). */
@ApiTags('Stripe webhooks — admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/subscriptions/admin/webhooks')
export class StripeWebhookAdminController {
  constructor(private readonly webhookService: StripeWebhookService) {}

  @Get()
  history(@Query() query: any) {
    return this.webhookService.adminHistory(query);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.webhookService.adminRetry(id);
  }
}
