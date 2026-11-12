/* eslint-disable prettier/prettier */
import { BadRequestException, Controller, Headers, HttpCode, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { PaymentsWebhookService } from './payments-webhook.service';

@ApiTags('Payments — webhooks')
@Controller('api/payments/webhooks')
export class PaymentsWebhookController {
  constructor(private readonly webhooks: PaymentsWebhookService) {}

  // No auth guard by design: the provider cannot present a bearer token. Trust comes ONLY from the provider's signature over the raw body,
  // verified inside the service before anything is parsed or stored. Not rate-limited (a provider's shared IPs would trip a per-IP limit).
  @SkipThrottle()
  @ApiExcludeEndpoint()
  @HttpCode(200)
  @Post(':provider')
  async receive(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string>) {
    if (!req.rawBody) throw new BadRequestException('Raw request body unavailable — check the rawBody bootstrap setting');
    return this.webhooks.receive(provider.toLowerCase(), req.rawBody, headers);
  }
}
