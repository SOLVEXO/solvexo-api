/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { StripeConnectService } from '../stripe-connect/stripe-connect.service';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { encryptCredential, decryptCredential, maskSecret } from '../common/credential-encryption.util';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { WhatsAppCloudProvider } from './providers/whatsapp-cloud.provider';
import { toDecryptedPaymentConfig } from './integration-credentials.helper';
import {
  STORE_INTEGRATION_PROVIDERS,
  StoreIntegrationDocument,
  StoreIntegrationProvider,
  StoreIntegrationType,
} from './schemas/store-integration.schema';

/** Providers available for a store's own bound currency — see Phase 2 §currency and Store.baseCurrency. */
const PROVIDERS_BY_CURRENCY: Record<'PKR' | 'USD', StoreIntegrationProvider[]> = {
  PKR: ['safepay', 'jazzcash', 'easypaisa', 'payfast'],
  USD: ['stripe'],
};

function maskCredentials(credentials: Record<string, any>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value === 'string') masked[key] = maskSecret(value);
  }
  return masked;
}

@Injectable()
export class StoreIntegrationsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly registry: PaymentProviderRegistry,
    private readonly whatsAppProvider: WhatsAppCloudProvider,
    private readonly stripeConnectService: StripeConnectService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  private async assertOwnedStore(storeId: string, sellerId: string) {
    return verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
  }

  private toPublicView(integration: StoreIntegrationDocument) {
    return {
      id: String(integration._id),
      type: integration.type,
      provider: integration.provider,
      mode: integration.mode,
      status: integration.status,
      isEnabledForCheckout: integration.isEnabledForCheckout,
      lastVerifiedAt: integration.lastVerifiedAt,
      lastError: integration.lastError,
      config: { ...integration.config, maskedHints: undefined },
      maskedHints: integration.config?.maskedHints ?? {},
      // Not a secret — it's a routing token embedded in a public webhook
      // URL, not credentials. The seller needs this back to actually
      // register `{yourBackendBaseUrl}/webhooks/payments/{provider}/{webhookToken}`
      // with the gateway. Null for types (e.g. whatsapp) that don't use
      // per-store webhook URLs at all.
      webhookToken: integration.webhookToken ?? null,
      createdAt: (integration as any).createdAt,
      updatedAt: (integration as any).updatedAt,
    };
  }

  /**
   * Available + connected integrations for this store, scoped by its own
   * `baseCurrency` (never a client-supplied currency) — a PKR store only
   * ever sees Pakistani gateways, a USD store only ever sees Stripe. Stripe
   * has no `StoreIntegration` row of its own (see StripePaymentProvider's
   * class doc) — its entry here is synthesized live from the existing
   * per-seller Stripe Connect status instead of being stored twice.
   */
  async list(storeId: string, sellerId: string) {
    const store = await this.assertOwnedStore(storeId, sellerId);
    const currency: 'PKR' | 'USD' = store.baseCurrency === 'USD' ? 'USD' : 'PKR';
    // Only providers with a real implementation registered show up — jazzcash/easypaisa/payfast
    // stay hidden from the seller dashboard until their provider classes exist.
    const availableProviders = PROVIDERS_BY_CURRENCY[currency].filter((p) => this.registry.isSupported(p));

    const stored = await this.repos.storeIntegrationModel.find({ storeId, type: 'payment' });
    const byProvider = new Map(stored.map((doc) => [doc.provider, doc]));

    const payment = await Promise.all(
      availableProviders.map(async (provider) => {
        if (provider === 'stripe') {
          const { data } = await this.stripeConnectService.getStatus(sellerId);
          return {
            id: null,
            type: 'payment' as const,
            provider: 'stripe' as const,
            mode: 'live' as const,
            status: data.connected && data.chargesEnabled && data.payoutsEnabled ? 'connected' : data.connected ? 'error' : 'not_connected',
            isEnabledForCheckout: data.connected && data.chargesEnabled && data.payoutsEnabled,
            lastVerifiedAt: null,
            lastError: data.connected && !(data.chargesEnabled && data.payoutsEnabled) ? 'Stripe onboarding incomplete' : null,
            config: { displayName: 'Card payment (Stripe)', currency: 'USD' },
            maskedHints: {},
            manageVia: { statusUrl: '/api/stripe-connect/status', connectUrl: '/api/stripe-connect/onboarding-link' },
          };
        }
        const doc = byProvider.get(provider);
        if (doc) return this.toPublicView(doc);
        return {
          id: null,
          type: 'payment' as const,
          provider,
          mode: 'sandbox' as const,
          status: 'not_connected' as const,
          isEnabledForCheckout: false,
          lastVerifiedAt: null,
          lastError: null,
          config: { currency },
          maskedHints: {},
        };
      }),
    );

    const whatsapp = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'whatsapp', provider: 'whatsapp_cloud' });

    return {
      success: true,
      data: {
        payment,
        whatsapp: whatsapp
          ? this.toPublicView(whatsapp)
          : {
              id: null,
              type: 'whatsapp' as const,
              provider: 'whatsapp_cloud' as const,
              mode: 'live' as const,
              status: 'not_connected' as const,
              isEnabledForCheckout: false,
              lastVerifiedAt: null,
              lastError: null,
              config: {},
              maskedHints: {},
            },
      },
    };
  }

  async connect(storeId: string, sellerId: string, type: StoreIntegrationType, provider: StoreIntegrationProvider, body: Record<string, any>) {
    const store = await this.assertOwnedStore(storeId, sellerId);

    if (!STORE_INTEGRATION_PROVIDERS.includes(provider)) {
      throw new BadRequestException(`Unknown provider "${provider}"`);
    }
    if (provider === 'stripe') {
      throw new BadRequestException(
        'Stripe is connected via the existing Stripe Connect onboarding flow — POST /api/stripe-connect/onboarding-link, not this endpoint.',
      );
    }

    if (type === 'payment') {
      const currency = store.baseCurrency === 'USD' ? 'USD' : 'PKR';
      if (!PROVIDERS_BY_CURRENCY[currency].includes(provider)) {
        throw new BadRequestException(`"${provider}" is not available for a ${currency} store`);
      }
      return this.connectPayment(storeId, sellerId, provider, body);
    }
    if (type === 'whatsapp' && provider === 'whatsapp_cloud') {
      return this.connectWhatsApp(storeId, sellerId, body);
    }
    throw new BadRequestException(`"${provider}" does not support type "${type}"`);
  }

  private async connectPayment(storeId: string, sellerId: string, provider: StoreIntegrationProvider, body: Record<string, any>) {
    if (provider === 'safepay') {
      const { secretKey, clientId, webhookSecret, displayName } = body;
      if (!secretKey || !clientId) {
        throw new BadRequestException('secretKey and clientId are required');
      }
      // `webhookSecret` is deliberately optional here — Safepay only issues
      // it once a webhook URL is registered in their dashboard, and that URL
      // is only knowable after this call generates `webhookToken` below.
      // Real sequence: connect with just secretKey+clientId -> we hand back
      // the webhookToken-bearing URL -> seller registers it with Safepay,
      // gets a webhookSecret -> PATCH .../:id with { webhookSecret } to add
      // it (see `update()`). Inbound webhooks fail safely (rejected, not a
      // security hole) until it's added — `SafepayPaymentProvider.handleWebhook`
      // simply can't compute a valid HMAC against a null secret.
      const credentials = { secretKey, clientId, webhookSecret: webhookSecret ?? null };
      const credentialsEncrypted = encryptCredential(JSON.stringify(credentials), 'INTEGRATIONS');
      const mode = String(secretKey).includes('_live_') ? 'live' : 'sandbox';

      const doc = await this.repos.storeIntegrationModel.findOneAndUpdate(
        { storeId, type: 'payment', provider },
        {
          $set: {
            sellerId,
            mode,
            status: 'connected',
            credentialsEncrypted,
            'config.displayName': displayName ?? 'Safepay',
            'config.currency': 'PKR',
            'config.maskedHints': maskCredentials(credentials),
            lastError: null,
          },
          $setOnInsert: { webhookToken: randomBytes(32).toString('hex'), isEnabledForCheckout: false },
        },
        { new: true, upsert: true },
      );

      await this.logChange(storeId, sellerId, 'integration.connect', doc, { provider, mode });
      return { success: true, data: this.toPublicView(doc) };
    }

    // JazzCash/Easypaisa/PayFast follow the same shape once their provider
    // classes are implemented (see PaymentProviderRegistry) — not built yet.
    throw new BadRequestException(`"${provider}" is not implemented yet`);
  }

  private async connectWhatsApp(storeId: string, sellerId: string, body: Record<string, any>) {
    const { code, phoneNumberId, businessId, displayName } = body;
    if (!code || !phoneNumberId) {
      throw new BadRequestException('code and phoneNumberId are required (from the Embedded Signup callback)');
    }

    const { accessToken, expiresAt } = await this.whatsAppProvider.exchangeAuthCode(code);

    // Never trust a client-claimed phoneNumberId/wabaId — prove the token
    // this store's seller actually authenticated with has real access to
    // that phone number first, since inbound webhook routing matches
    // purely on this field (see Phase 8 security review). `wabaId` is
    // taken from Meta's own response, never the request body.
    const { verified, wabaId } = await this.whatsAppProvider.verifyPhoneNumberAccess(accessToken, phoneNumberId);
    if (!verified) {
      throw new BadRequestException('This access token does not have access to the given phoneNumberId');
    }

    const existingElsewhere = await this.repos.storeIntegrationModel.findOne({
      type: 'whatsapp',
      'config.phoneNumberId': phoneNumberId,
      storeId: { $ne: storeId },
    });
    if (existingElsewhere) {
      throw new BadRequestException('This WhatsApp phone number is already connected to a different store');
    }

    const credentialsEncrypted = encryptCredential(JSON.stringify({ accessToken }), 'INTEGRATIONS');

    const doc = await this.repos.storeIntegrationModel.findOneAndUpdate(
      { storeId, type: 'whatsapp', provider: 'whatsapp_cloud' },
      {
        $set: {
          sellerId,
          mode: 'live',
          status: 'connected',
          credentialsEncrypted,
          'config.displayName': displayName ?? 'WhatsApp Business',
          'config.wabaId': wabaId,
          'config.phoneNumberId': phoneNumberId,
          'config.businessId': businessId ?? null,
          'config.tokenExpiresAt': expiresAt,
          lastVerifiedAt: new Date(),
          lastError: null,
        },
        $setOnInsert: { isEnabledForCheckout: false },
      },
      { new: true, upsert: true },
    );

    await this.logChange(storeId, sellerId, 'integration.connect', doc, { provider: 'whatsapp_cloud' });
    return { success: true, data: this.toPublicView(doc) };
  }

  /**
   * Confirms the stored credentials still work, without going live.
   * WhatsApp: a real check against Meta's `debug_token` endpoint. Payment
   * gateways: validates the credentials are present and well-formed only —
   * NOT a live sandbox transaction, since that would require confirming
   * each gateway's own no-op verification endpoint against a real sandbox
   * account first (flagged in SafepayPaymentProvider's own file doc; do not
   * extend this to a live call without that confirmation).
   */
  async test(storeId: string, sellerId: string, id: string) {
    await this.assertOwnedStore(storeId, sellerId);
    const integration = await this.repos.storeIntegrationModel.findOne({ _id: id, storeId });
    if (!integration) throw new NotFoundException('Integration not found');

    let ok = false;
    let message = '';
    if (integration.type === 'whatsapp') {
      const config = toDecryptedPaymentConfig(integration);
      const { isValid } = await this.whatsAppProvider.checkTokenValidity(config.credentials.accessToken);
      ok = isValid;
      message = isValid ? 'WhatsApp access token is valid' : 'WhatsApp access token is invalid or expired';
    } else {
      ok = !!integration.credentialsEncrypted;
      message = ok ? 'Credentials are present and decrypt correctly' : 'No credentials stored';
      if (ok) {
        try {
          decryptCredential(integration.credentialsEncrypted!, 'INTEGRATIONS');
        } catch {
          ok = false;
          message = 'Stored credentials failed to decrypt';
        }
      }
    }

    await this.repos.storeIntegrationModel.updateOne(
      { _id: id },
      ok
        ? { $set: { lastVerifiedAt: new Date(), lastError: null } }
        : { $set: { status: 'error', lastError: message } },
    );
    await this.logChange(storeId, sellerId, 'integration.test', integration, { result: ok ? 'ok' : 'failed' });

    return { success: true, data: { ok, message } };
  }

  async update(
    storeId: string,
    sellerId: string,
    id: string,
    patch: { isEnabledForCheckout?: boolean; displayName?: string; webhookSecret?: string },
  ) {
    await this.assertOwnedStore(storeId, sellerId);
    const integration = await this.repos.storeIntegrationModel.findOne({ _id: id, storeId });
    if (!integration) throw new NotFoundException('Integration not found');

    if (patch.isEnabledForCheckout && integration.mode === 'live' && !integration.lastVerifiedAt) {
      throw new BadRequestException('Run a successful test before enabling a live-mode integration for checkout');
    }

    const $set: Record<string, any> = {};
    if (typeof patch.isEnabledForCheckout === 'boolean') $set.isEnabledForCheckout = patch.isEnabledForCheckout;
    if (patch.displayName) $set['config.displayName'] = patch.displayName;

    // Step 2 of the connect flow's own doc comment: the seller only gets a
    // real webhookSecret from the gateway's dashboard AFTER registering the
    // webhookToken-bearing URL there, which is only knowable after connect()
    // already ran — so it arrives here, later, merged into the existing
    // encrypted credential blob rather than requiring a second connect() call.
    if (patch.webhookSecret) {
      if (!integration.credentialsEncrypted) {
        throw new BadRequestException('Connect this integration with its API credentials first');
      }
      const existing = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS'));
      const merged = { ...existing, webhookSecret: patch.webhookSecret };
      $set.credentialsEncrypted = encryptCredential(JSON.stringify(merged), 'INTEGRATIONS');
      $set['config.maskedHints'] = maskCredentials(merged);
      $set.lastError = null;
    }

    const doc = await this.repos.storeIntegrationModel.findOneAndUpdate({ _id: id, storeId }, { $set }, { new: true });
    await this.logChange(storeId, sellerId, 'integration.update', doc!, {
      changedFields: Object.keys($set).map((f) => (f === 'credentialsEncrypted' ? 'credentials.webhookSecret' : f)),
    });
    return { success: true, data: this.toPublicView(doc!) };
  }

  /** Wipes the credential blob and reverts to `not_connected` — keeps the row (audit trail, webhookToken history) rather than hard-deleting it. */
  async disconnect(storeId: string, sellerId: string, id: string) {
    await this.assertOwnedStore(storeId, sellerId);
    const integration = await this.repos.storeIntegrationModel.findOne({ _id: id, storeId });
    if (!integration) throw new NotFoundException('Integration not found');

    const doc = await this.repos.storeIntegrationModel.findOneAndUpdate(
      { _id: id, storeId },
      {
        $set: {
          status: 'not_connected',
          credentialsEncrypted: null,
          isEnabledForCheckout: false,
          'config.maskedHints': {},
          lastVerifiedAt: null,
          lastError: null,
        },
      },
      { new: true },
    );
    await this.logChange(storeId, sellerId, 'integration.disconnect', doc!, { provider: integration.provider });
    return { success: true, message: 'Integration disconnected' };
  }

  private async logChange(storeId: string, sellerId: string, action: string, integration: StoreIntegrationDocument, metadata: Record<string, any>) {
    await this.activityLogService.log({
      storeId,
      category: 'integrations',
      action,
      description: `${integration.type}/${integration.provider} — ${action}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: String(integration._id),
      targetType: 'StoreIntegration',
      isSecurityAlert: true,
      metadata,
    });
  }
}
