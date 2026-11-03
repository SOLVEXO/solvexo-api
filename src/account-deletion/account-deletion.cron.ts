/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '@/redis/redis.service';
import { SellerAccountDeletionService } from './seller-account-deletion.service';
import { AppleTokenService } from '../auth/apple-token.service';

@Injectable()
export class AccountDeletionCron {
  private readonly logger = new Logger(AccountDeletionCron.name);
  constructor(private readonly service: SellerAccountDeletionService, private readonly redis: RedisService, private readonly appleTokens: AppleTokenService) {}

  /** Daily 03:10 — single-instance via the shared Redis lock, like every other cron here. */
  @Cron('10 3 * * *')
  async cron() {
    const r = await this.redis.withLock('cron-lock:account-deletion', 30 * 60_000, async () => {
      const n = await this.service.purgeDue();
      if (n > 0) this.logger.log(`Purged ${n} deleted seller account(s)`);
    });
    if (r === 'lock_not_acquired') this.logger.debug('Skipped account purge: lock held elsewhere or Redis unavailable');
  }

  /** Hourly: retries Sign in with Apple token revocations that failed at purge time (exponential backoff, gives up loudly after 8 tries). */
  @Cron('25 * * * *')
  async retryAppleRevocations() {
    const r = await this.redis.withLock('cron-lock:apple-revocation', 20 * 60_000, async () => {
      const n = await this.appleTokens.retryDue();
      if (n > 0) this.logger.log(`Retried ${n} pending Apple token revocation(s)`);
    });
    if (r === 'lock_not_acquired') this.logger.debug('Skipped Apple revocation retry: lock held elsewhere or Redis unavailable');
  }
}
