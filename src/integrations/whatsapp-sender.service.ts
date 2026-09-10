/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { decryptCredential } from '../common/credential-encryption.util';
import { WhatsAppCloudProvider } from './providers/whatsapp-cloud.provider';

/**
 * The one place that turns "send this order template to this store's
 * customer" into an actual WhatsApp Cloud API call — resolves the store's
 * `StoreIntegration`, decrypts its token, and no-ops (not an error) when the
 * store simply hasn't connected WhatsApp. Called from
 * `NotificationsProcessor` so order-lifecycle code only ever talks to
 * `NotificationsService.notify()`, never this module directly.
 */
@Injectable()
export class WhatsAppSenderService {
  private readonly logger = new Logger(WhatsAppSenderService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly provider: WhatsAppCloudProvider,
  ) {}

  async sendOrderTemplate(
    storeId: string,
    to: string,
    templateName: string,
    languageCode: string,
    bodyParams?: string[],
  ): Promise<void> {
    const integration = await this.databaseService.repositories.storeIntegrationModel.findOne({
      storeId,
      type: 'whatsapp',
      provider: 'whatsapp_cloud',
      status: 'connected',
    });
    if (!integration?.credentialsEncrypted) return;

    const phoneNumberId = integration.config?.phoneNumberId;
    const wabaId = integration.config?.wabaId;
    if (!phoneNumberId) return;

    let accessToken: string;
    try {
      accessToken = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS')).accessToken;
    } catch (err: any) {
      this.logger.error(`Failed to decrypt WhatsApp credentials for store ${storeId}: ${err?.message}`);
      return;
    }

    const result = await this.provider.sendTemplateMessage(
      { accessToken, phoneNumberId, wabaId },
      to,
      { templateName, languageCode, bodyParams },
    );
    if (!result.success) {
      this.logger.warn(`WhatsApp send failed for store ${storeId} -> ${to} (template "${templateName}"): ${result.error}`);
    }
  }
}
