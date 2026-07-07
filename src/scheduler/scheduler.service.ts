/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from 'src/database/databaseservice';
import { LoyaltyService } from 'src/loyalty/loyalty.service';

@Injectable()
export class SchedulerService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly loyaltyService: LoyaltyService,
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
}
