/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from 'src/database/databaseservice';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { SubscriptionsService } from 'src/subscriptions/subscriptions.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly loyaltyService: LoyaltyService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  @Cron('* * * * *')
  async activateScheduledProducts() {
    const { productModel } = this.databaseService.repositories;

    await productModel.updateMany(
      {
        status: 'scheduled',
        scheduledAt: { $lte: new Date() },
        isDelete: false,
      },
      {
        $set: { status: 'active', scheduledAt: null },
      },
    );
  }

  // Runs daily — cheap no-op for members who haven't crossed their program's expiry window yet.
  @Cron('0 2 * * *')
  async expireLoyaltyPoints() {
    await this.loyaltyService.expireInactivePoints();
  }

  // Runs hourly — charges every subscription whose billing period has ended,
  // and drives the dunning/auto-cancel state machine on failure. Uses
  // PaymentGatewayService under the hood (currently ManualPaymentProvider);
  // swapping in a real provider later requires no changes here.
  @Cron('0 * * * *')
  async runSubscriptionRenewals() {
    const result = await this.subscriptionsService.processRenewals();
    if (result.processed > 0) {
      this.logger.log(
        `Subscription renewals: ${result.processed} processed, ${result.succeeded} succeeded, ${result.failed} failed, ${result.canceled} auto-canceled`,
      );
    }
  }

  // Runs daily — finalizes subscriptions whose "cancel at period end" date has arrived.
  @Cron('30 2 * * *')
  async finalizeSubscriptionCancellations() {
    const result = await this.subscriptionsService.finalizeEndOfPeriodCancellations();
    if (result.canceled > 0) {
      this.logger.log(`Finalized ${result.canceled} end-of-period subscription cancellation(s)`);
    }
  }
}
