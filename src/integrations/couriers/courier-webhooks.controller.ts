/* eslint-disable prettier/prettier */
import { Controller, HttpCode, NotFoundException, NotImplementedException, Param, Post } from '@nestjs/common';
import { DatabaseService } from '../../database/databaseservice';
import { CourierProviderRegistry } from './courier-provider.registry';
import { isCourierKey } from './courier.types';

/**
 * Courier PUSH webhook — intentionally STUBBED. No courier's push webhook (payload shape, signature scheme) has been
 * confirmed from official documentation, so nothing is accepted here: tracking is PULLED by CourierTrackingSyncService.
 *
 * To enable one courier (docs/courier-module.md, "Adding push webhooks"): confirm its docs, set `pushWebhook: true` in
 * its mapping capabilities, verify the signature against the seller's stored secret (never trust the body), map the
 * payload with that courier's mapping, and call CourierTrackingSyncService.applyTrackResult — the same idempotent
 * path the cron uses. The `:token` is the per-integration `webhookToken` (already generated at connect time).
 */
@Controller('webhooks/couriers')
export class CourierWebhooksController {
  constructor(private readonly db: DatabaseService, private readonly registry: CourierProviderRegistry) {}

  @Post(':provider/:token')
  @HttpCode(501)
  async receive(@Param('provider') provider: string, @Param('token') token: string) {
    if (!isCourierKey(provider) || !this.registry.isSupported(provider)) throw new NotFoundException();
    const integration = await this.db.repositories.storeIntegrationModel.findOne({ type: 'courier', provider, webhookToken: token }).select('_id').lean();
    if (!integration) throw new NotFoundException();
    if (!this.registry.resolve(provider).capabilities.pushWebhook) {
      throw new NotImplementedException('This courier has no verified push webhook; tracking is pulled by the sync job.');
    }
    throw new NotImplementedException('Courier push webhook handling is not implemented.');
  }
}
