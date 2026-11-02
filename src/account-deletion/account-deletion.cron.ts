/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '@/redis/redis.service';
import { SellerAccountDeletionService } from './seller-account-deletion.service';

@Injectable()
export class AccountDeletionCron {
  private readonly logger = new Logger(AccountDeletionCron.name);
  constructor(private readonly service: SellerAccountDeletionService, private readonly redis: RedisService) {}

  /** Daily 03:10 — single-instance via the shared Redis lock, like every other cron here. */
  @Cron('10 3 * * *')
  async cron() {
    const r = await this.redis.withLock('cron-lock:account-deletion', 30 * 60_000, async () => {
      const n = await this.service.purgeDue();
      if (n > 0) this.logger.log(`Purged ${n} deleted seller account(s)`);
    });
    if (r === 'lock_not_acquired') this.logger.debug('Skipped account purge: lock held elsewhere or Redis unavailable');
  }
}
