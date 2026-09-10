/* eslint-disable prettier/prettier */
import { BadRequestException, Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PosPlansWebhookService } from './pos-plans-webhook.service';

@Controller('api/pos-subscriptions/webhooks')
export class PosPlansWebhookController {
  constructor(private readonly webhookService: PosPlansWebhookService) {}

  @SkipThrottle()
  @ApiExcludeEndpoint()
  @Post('stripe')
  @HttpCode(200)
  async handleStripeWebhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string) {
    if (!req.rawBody) {
      throw new BadRequestException('Raw request body unavailable — check RawBodyRequest / bootstrap rawBody config');
    }
    return this.webhookService.receive(req.rawBody, signature);
  }
}
