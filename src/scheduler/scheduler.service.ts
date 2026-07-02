/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from 'src/database/databaseservice';

@Injectable()
export class SchedulerService {
  constructor(private readonly databaseService: DatabaseService) {}

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
}
