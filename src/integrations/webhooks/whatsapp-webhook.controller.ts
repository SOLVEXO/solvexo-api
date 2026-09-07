/* eslint-disable prettier/prettier */
import { BadRequestException, Controller, Get, Headers, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { DatabaseService } from '../../database/databaseservice';
import { WhatsAppCloudProvider } from '../providers/whatsapp-cloud.provider';

/**
 * Single, platform-wide WhatsApp webhook — NOT one URL per store like the
 * payment gateways. Meta's WhatsApp Cloud API only supports one webhook per
 * App, covering every store's WABA at once; a per-store URL scheme isn't an
 * option here. Store attribution instead comes from the payload's own
 * `phone_number_id` (see `WhatsAppCloudProvider.parseWebhookPayload`),
 * cross-referenced against `StoreIntegration.config.phoneNumberId` — the
 * platform App Secret verifies "this came from Meta", the phone_number_id
 * lookup answers "which store is this for".
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly provider: WhatsAppCloudProvider,
  ) {}

  /** Meta's one-time subscription handshake (`hub.mode=subscribe`) when the webhook URL is registered in the App Dashboard. */
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const expected = this.configService.get<string>('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected && verifyToken === expected) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send('Verification failed');
  }

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post()
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string) {
    if (!req.rawBody) {
      throw new BadRequestException('Raw request body unavailable — check rawBody bootstrap config');
    }
    if (!this.provider.verifyWebhookSignature(req.rawBody, signature)) {
      throw new BadRequestException('Webhook signature verification failed');
    }

    const event = this.provider.parseWebhookPayload(req.rawBody);
    if (!event.phoneNumberId) {
      return { received: true };
    }

    const integration = await this.databaseService.repositories.storeIntegrationModel.findOne({
      type: 'whatsapp',
      provider: 'whatsapp_cloud',
      'config.phoneNumberId': event.phoneNumberId,
    });
    if (!integration) {
      // Not one of our connected stores (or it was disconnected) — Meta
      // still expects a 200 for any well-formed, correctly-signed event.
      return { received: true };
    }

    // Applying message-status updates / inbound replies to the messaging
    // module's own conversation records is wired once that linkage exists
    // (mirrors the payment webhook's same deferred order-mutation note).

    return { received: true };
  }
}
