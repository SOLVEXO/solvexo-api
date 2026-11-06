/* eslint-disable prettier/prettier */
import { Body, Controller, NotFoundException, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { SmsGatewayService } from './sms-gateway.service';
import { MessagingWebhookService } from './messaging-webhook.service';

/**
 * Where a store's SMS gateway posts replies and delivery reports. The URL carries a per-store secret (shown once, only its hash is kept):
 * a wrong secret looks exactly like a store that does not exist, and a report can only touch that store's own messages.
 */
@ApiTags('SMS webhooks (public)')
@Controller('api/public/sms/:storeId/:secret')
export class PublicSmsController {
  constructor(private readonly gateway: SmsGatewayService, private readonly hooks: MessagingWebhookService) {}

  private async check(storeId: string, secret: string) {
    if (!(await this.gateway.verifyWebhookSecret(storeId, secret))) throw new NotFoundException();
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('inbound')
  async inbound(@Param('storeId') storeId: string, @Param('secret') secret: string, @Body() body: any) { await this.check(storeId, secret); return this.hooks.handleSmsInbound(storeId, body); }

  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Post('delivery')
  async delivery(@Param('storeId') storeId: string, @Param('secret') secret: string, @Body() body: any) { await this.check(storeId, secret); return this.hooks.handleSmsDelivery(storeId, body); }
}
