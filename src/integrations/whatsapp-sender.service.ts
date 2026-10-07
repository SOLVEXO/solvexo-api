/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { decryptCredential } from '../common/credential-encryption.util';
import { WhatsAppCloudProvider } from './providers/whatsapp-cloud.provider';
import {
  WhatsAppEvent,
  WhatsAppEventVars,
  buildWhatsAppBodyParams,
  normalizeWhatsAppRecipient,
  resolveWhatsAppEventSettings,
} from './whatsapp-events';

/**
 * The one place that turns "send this order message to this store's customer" into an actual WhatsApp Cloud API
 * call — resolves the store's `StoreIntegration`, decrypts its token, and no-ops (not an error) when the store
 * hasn't connected WhatsApp. When an `event` is given, the store's own per-event switch, template name, language and
 * variable mapping (`config.notifications`, see whatsapp-events.ts) decide what is sent — a switched-off event sends
 * nothing. Called from `NotificationsProcessor` so order-lifecycle code only ever talks to
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
    event?: WhatsAppEvent,
    vars?: WhatsAppEventVars,
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

    if (event) {
      const settings = resolveWhatsAppEventSettings(integration.config, event);
      if (!settings.enabled) return;
      templateName = settings.templateName;
      languageCode = settings.languageCode;
      if (vars) bodyParams = buildWhatsAppBodyParams(settings.params, vars);
    }

    const recipient = normalizeWhatsAppRecipient(to);
    if (!recipient) return;

    let accessToken: string;
    try {
      accessToken = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS')).accessToken;
    } catch (err: any) {
      this.logger.error(`Failed to decrypt WhatsApp credentials for store ${storeId}: ${err?.message}`);
      return;
    }

    const result = await this.provider.sendTemplateMessage(
      { accessToken, phoneNumberId, wabaId },
      recipient,
      { templateName, languageCode, bodyParams },
    );
    if (!result.success) {
      this.logger.warn(`WhatsApp send failed for store ${storeId} -> ${recipient} (template "${templateName}"): ${result.error}`);
    }
  }
}
