/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';

@Injectable()
export class IntegrationWebhookEventService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get model() {
    return this.databaseService.repositories.integrationWebhookEventModel;
  }

  /**
   * Records this (provider, externalEventId) pair. Returns `false` when it's
   * a duplicate (the unique index rejects the insert) — callers must
   * short-circuit to a 200 without reprocessing rather than mutate an order
   * a second time for a gateway's retried delivery.
   */
  async recordOnce(provider: string, externalEventId: string, storeId: string): Promise<boolean> {
    try {
      await this.model.create({ provider, externalEventId, storeId });
      return true;
    } catch (err: any) {
      if (err?.code === 11000) return false;
      throw err;
    }
  }
}
