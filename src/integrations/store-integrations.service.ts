/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { StripeConnectService } from '../stripe-connect/stripe-connect.service';
import { TaxService } from '../tax/tax.service';
import { ShippingRatesService, ShippingSettingsInput } from '../shipping-rates/shipping-rates.service';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { encryptCredential, decryptCredential, maskSecret } from '../common/credential-encryption.util';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { WhatsAppCloudProvider } from './providers/whatsapp-cloud.provider';
import { toDecryptedPaymentConfig } from './integration-credentials.helper';
import { WHATSAPP_EVENTS, WHATSAPP_PARAM_TOKENS, isWhatsAppEvent, resolveWhatsAppEventSettings } from './whatsapp-events';
import {
  STORE_INTEGRATION_PROVIDERS,
  StoreIntegrationDocument,
  StoreIntegrationProvider,
  StoreIntegrationType,
} from './schemas/store-integration.schema';

/** Providers available for a store's own bound currency — see Phase 2 §currency and Store.baseCurrency. */
const PROVIDERS_BY_CURRENCY: Record<'PKR' | 'USD', StoreIntegrationProvider[]> = {
  PKR: ['safepay', 'jazzcash', 'easypaisa', 'payfast', 'bank_transfer'],
  USD: ['stripe'],
};

// Providers with no PaymentProviderRegistry entry at all — not a real-time
// gateway (no API calls, no webhook), so `registry.isSupported()` below
// would always exclude it. Stays available whenever it's in the
// currency-gated list, same as 'stripe' is unconditionally appended.
const REGISTRY_EXEMPT_PROVIDERS: StoreIntegrationProvider[] = ['bank_transfer'];

/** Seller-chosen test/live mode; falls back to `fallback` when absent/invalid. */
function resolveMode(requested: unknown, fallback: 'sandbox' | 'live'): 'sandbox' | 'live' {
  return requested === 'live' || requested === 'sandbox' ? requested : fallback;
}

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
    private readonly taxService: TaxService,
    private readonly shippingRatesService: ShippingRatesService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  private async assertOwnedStore(storeId: string, sellerId: string) {
    return verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
  }

  async assertStoreAccess(storeId: string, sellerId: string) {
    await this.assertOwnedStore(storeId, sellerId);
  }

  // ── Seller-defined custom manual payment methods (Shopify "Custom payment method") ──
  private manualView(m: any) {
    return { id: String(m._id), name: m.name, instructions: m.instructions ?? '', isActive: !!m.isActive, sortOrder: m.sortOrder ?? 0 };
  }

  /** Active + inactive methods for the seller's integrations page (callers already verified the store). */
  async listManualMethods(storeId: string) {
    const rows = await this.repos.manualPaymentMethodModel.find({ storeId, isDelete: false }).sort({ sortOrder: 1, createdAt: 1 }).lean();
    return (rows as any[]).map((m) => this.manualView(m));
  }

  private parseManualBody(body: Record<string, any>, partial: boolean) {
    const out: Record<string, any> = {};
    if (!partial || body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 60) throw new BadRequestException('Name is required (max 60 characters)');
      out.name = name;
    }
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== 'string' || body.instructions.length > 2000) throw new BadRequestException('Instructions must be text up to 2000 characters');
      out.instructions = body.instructions;
    }
    if (body.isActive !== undefined) out.isActive = body.isActive === true;
    if (body.sortOrder !== undefined) {
      const n = Number(body.sortOrder);
      if (!Number.isFinite(n)) throw new BadRequestException('sortOrder must be a number');
      out.sortOrder = Math.trunc(n);
    }
    return out;
  }

  async createManualMethod(storeId: string, sellerId: string, body: Record<string, any>) {
    await this.assertOwnedStore(storeId, sellerId);
    const data = this.parseManualBody(body ?? {}, false);
    const count = await this.repos.manualPaymentMethodModel.countDocuments({ storeId, isDelete: false });
    if (count >= 20) throw new BadRequestException('You can add up to 20 custom payment methods');
    try {
      const doc = await this.repos.manualPaymentMethodModel.create({ storeId, isActive: true, sortOrder: count, ...data });
      return { success: true, data: this.manualView(doc.toObject()) };
    } catch (e: any) {
      if (e?.code === 11000) throw new BadRequestException('A payment method with this name already exists');
      throw e;
    }
  }

  async updateManualMethod(storeId: string, sellerId: string, methodId: string, body: Record<string, any>) {
    await this.assertOwnedStore(storeId, sellerId);
    const data = this.parseManualBody(body ?? {}, true);
    try {
      const doc: any = await this.repos.manualPaymentMethodModel
        .findOneAndUpdate({ _id: methodId, storeId, isDelete: false }, { $set: data }, { new: true })
        .lean();
      if (!doc) throw new NotFoundException('Payment method not found');
      return { success: true, data: this.manualView(doc) };
    } catch (e: any) {
      if (e?.code === 11000) throw new BadRequestException('A payment method with this name already exists');
      throw e;
    }
  }

  async deleteManualMethod(storeId: string, sellerId: string, methodId: string) {
    await this.assertOwnedStore(storeId, sellerId);
    const res = await this.repos.manualPaymentMethodModel.updateOne({ _id: methodId, storeId, isDelete: false }, { $set: { isDelete: true, isActive: false } });
    if (!res.matchedCount) throw new NotFoundException('Payment method not found');
    return { success: true };
  }

  // ── WhatsApp: per-event switches + template manager ──
  private async loadWhatsApp(storeId: string, sellerId: string) {
    await this.assertOwnedStore(storeId, sellerId);
    const integration = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'whatsapp', provider: 'whatsapp_cloud' });
    if (!integration || integration.status === 'not_connected' || !integration.credentialsEncrypted) {
      throw new BadRequestException('Connect WhatsApp first');
    }
    const accessToken: string = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS')).accessToken;
    return { integration, accessToken, wabaId: integration.config?.wabaId as string | undefined };
  }

  async getWhatsAppNotifications(storeId: string, sellerId: string) {
    await this.assertOwnedStore(storeId, sellerId);
    const integration = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'whatsapp', provider: 'whatsapp_cloud' });
    const events = WHATSAPP_EVENTS.map((event) => ({ event, ...resolveWhatsAppEventSettings(integration?.config, event) }));
    return { success: true, data: { events, paramTokens: WHATSAPP_PARAM_TOKENS } };
  }

  async updateWhatsAppNotification(storeId: string, sellerId: string, body: Record<string, any>) {
    const { integration } = await this.loadWhatsApp(storeId, sellerId);
    if (!isWhatsAppEvent(body?.event)) throw new BadRequestException('Unknown WhatsApp event');
    const event = body.event;
    const $set: Record<string, any> = {};
    if (typeof body.enabled === 'boolean') $set[`config.notifications.${event}.enabled`] = body.enabled;
    if (body.templateName !== undefined) {
      if (typeof body.templateName !== 'string' || !/^[a-z0-9_]{1,512}$/.test(body.templateName)) throw new BadRequestException('Template name must be lowercase letters, numbers and underscores');
      $set[`config.notifications.${event}.templateName`] = body.templateName;
    }
    if (body.languageCode !== undefined) {
      if (typeof body.languageCode !== 'string' || !/^[a-z]{2}(_[A-Z]{2})?$/.test(body.languageCode)) throw new BadRequestException('Invalid language code (e.g. en_US)');
      $set[`config.notifications.${event}.languageCode`] = body.languageCode;
    }
    if (body.params !== undefined) {
      if (!Array.isArray(body.params) || body.params.length > 10 || body.params.some((p: unknown) => !(WHATSAPP_PARAM_TOKENS as readonly string[]).includes(p as string))) {
        throw new BadRequestException('Invalid template variable mapping');
      }
      $set[`config.notifications.${event}.params`] = body.params;
    }
    if (!Object.keys($set).length) throw new BadRequestException('Nothing to update');
    // The template must be unusable only if the seller picks one that does not exist — Meta rejects it at send time; we do not block.
    await this.repos.storeIntegrationModel.updateOne({ _id: integration._id }, { $set });
    return this.getWhatsAppNotifications(storeId, sellerId);
  }

  async listWhatsAppTemplates(storeId: string, sellerId: string) {
    const { accessToken, wabaId } = await this.loadWhatsApp(storeId, sellerId);
    if (!wabaId) throw new BadRequestException('No WhatsApp Business Account is linked to this connection');
    const res = await this.whatsAppProvider.listTemplates(accessToken, wabaId);
    if (!res.ok) throw new BadRequestException(`Meta rejected the request: ${res.error}`);
    return { success: true, data: res.templates };
  }

  async createWhatsAppTemplate(storeId: string, sellerId: string, body: Record<string, any>) {
    const { accessToken, wabaId } = await this.loadWhatsApp(storeId, sellerId);
    if (!wabaId) throw new BadRequestException('No WhatsApp Business Account is linked to this connection');
    const name = String(body?.name ?? '');
    const language = String(body?.language ?? 'en_US');
    const category = String(body?.category ?? 'UTILITY').toUpperCase();
    const bodyText = String(body?.bodyText ?? '').trim();
    const examples: string[] = Array.isArray(body?.examples) ? body.examples.map((e: unknown) => String(e)) : [];
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new BadRequestException('Template name must be lowercase letters, numbers and underscores');
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(language)) throw new BadRequestException('Invalid language code (e.g. en_US)');
    if (!['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(category)) throw new BadRequestException('Invalid category');
    if (!bodyText || bodyText.length > 1024) throw new BadRequestException('Body text is required (max 1024 characters)');
    const placeholders = new Set((bodyText.match(/\{\{\d+\}\}/g) ?? []));
    if (examples.length < placeholders.size) throw new BadRequestException(`Provide an example value for each of the ${placeholders.size} variable(s)`);
    const res = await this.whatsAppProvider.createTemplate(accessToken, wabaId, {
      name, language, category: category as 'UTILITY' | 'MARKETING' | 'AUTHENTICATION', bodyText, examples: examples.slice(0, placeholders.size),
    });
    if (!res.ok) throw new BadRequestException(`Meta rejected the template: ${res.error}`);
    return { success: true, data: { id: res.id, status: res.status ?? 'PENDING' } };
  }

  async deleteWhatsAppTemplate(storeId: string, sellerId: string, name: string) {
    const { accessToken, wabaId } = await this.loadWhatsApp(storeId, sellerId);
    if (!wabaId) throw new BadRequestException('No WhatsApp Business Account is linked to this connection');
    if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new BadRequestException('Invalid template name');
    const res = await this.whatsAppProvider.deleteTemplate(accessToken, wabaId, name);
    if (!res.ok) throw new BadRequestException(`Meta rejected the request: ${res.error}`);
    return { success: true };
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
    // Checked directly against the store's REAL currency — not collapsed
    // into a PKR/USD binary, which used to silently treat every non-USD
    // store (GBP, EUR, AED, ...) as if it were PKR (a real bug for the
    // Markets/multi-currency expansion — see the currency-architecture
    // plan's "Real gap #1"). Local (PKR-only) gateways stay currency-gated —
    // a non-PKR store has no use for a PKR-settling provider. Stripe Connect
    // is deliberately NOT gated the same way: it's a per-SELLER capability
    // (one Stripe account, same level `Seller.stripeCustomerId` already
    // lives at), not tied to any one store's currency — a PKR-store seller
    // can and should still be able to connect it here too, the same as they
    // always could from the old standalone "Payment Gateway" Settings card
    // this replaced (see the seller-integrations frontend's
    // `StripeConnectSection`). Only providers with a real implementation
    // registered show up — jazzcash/easypaisa/payfast stay hidden from the
    // seller dashboard until their provider classes exist.
    const localProviders = store.baseCurrency === 'PKR' ? PROVIDERS_BY_CURRENCY.PKR : [];
    const availableProviders: StoreIntegrationProvider[] = [
      ...localProviders.filter((p) => REGISTRY_EXEMPT_PROVIDERS.includes(p) || this.registry.isSupported(p)),
      'stripe',
    ];

    const stored = await this.repos.storeIntegrationModel.find({ storeId, type: 'payment' });
    const byProvider = new Map(stored.map((doc) => [doc.provider, doc]));

    const payment = await Promise.all(
      availableProviders.map(async (provider) => {
        if (provider === 'stripe') {
          const { data } = await this.stripeConnectService.getStatus(sellerId, storeId);
          return {
            id: null,
            type: 'payment' as const,
            provider: 'stripe' as const,
            // The platform Stripe key decides: an sk_test_ key means every card payment is a Stripe TEST payment.
            mode: (this.stripeConnectService.isTestMode() ? 'sandbox' : 'live') as 'sandbox' | 'live',
            status: data.connected && data.chargesEnabled && data.payoutsEnabled ? 'connected' : data.connected ? 'error' : 'not_connected',
            isEnabledForCheckout: data.connected && data.chargesEnabled && data.payoutsEnabled,
            lastVerifiedAt: null,
            lastError: data.connected && !(data.chargesEnabled && data.payoutsEnabled) ? 'Stripe onboarding incomplete' : null,
            // Stripe Connect settles into the seller's own account in
            // whatever real currency their store is priced in — never
            // hardcoded to USD (that was the same binary-collapse bug as
            // the local-provider gating above).
            config: { displayName: 'Card payment (Stripe)', currency: store.baseCurrency ?? 'USD' },
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
          // Reached only for a local (PKR-only) gateway — `localProviders`
          // above is only ever populated when store.baseCurrency === 'PKR'.
          config: { currency: 'PKR' },
          maskedHints: {},
        };
      }),
    );

    const manualMethods = await this.listManualMethods(storeId);
    const whatsapp = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'whatsapp', provider: 'whatsapp_cloud' });
    const tax = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'tax', provider: 'taxjar' });
    const shipping = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'shipping', provider: 'shippo' });

    const notConnected = (type: StoreIntegrationType, provider: StoreIntegrationProvider) => ({
      id: null, type, provider, mode: 'live' as const, status: 'not_connected' as const,
      isEnabledForCheckout: false, lastVerifiedAt: null, lastError: null, config: {}, maskedHints: {},
      webhookToken: null,
    });

    return {
      success: true,
      data: {
        payment,
        manualMethods,
        whatsapp: whatsapp ? this.toPublicView(whatsapp) : notConnected('whatsapp', 'whatsapp_cloud'),
        // Real live tax (TaxJar) and shipping-rate (Shippo) connections — see
        // TaxService/ShippingRatesService for what "connected" actually
        // unlocks at checkout. Both are additive/opt-in, so `not_connected`
        // is a completely normal, unbroken state (the existing flat
        // Store.taxRate / per-zone shipping price keeps working).
        tax: tax ? this.toPublicView(tax) : notConnected('tax', 'taxjar'),
        shipping: shipping ? this.toPublicView(shipping) : notConnected('shipping', 'shippo'),
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
      // Every local gateway in PROVIDERS_BY_CURRENCY is PKR-only today, and
      // 'stripe' (the only USD-bucket entry) is already rejected above — so
      // this is really just "is this a PKR store," checked directly against
      // the store's real currency instead of a collapsed PKR/USD binary
      // (which used to name the wrong currency in the error message for any
      // non-PKR, non-USD store like GBP/EUR).
      if (store.baseCurrency !== 'PKR' || !PROVIDERS_BY_CURRENCY.PKR.includes(provider)) {
        throw new BadRequestException(`"${provider}" is not available for a ${store.baseCurrency ?? 'USD'} store`);
      }
      return this.connectPayment(storeId, sellerId, provider, body);
    }
    if (type === 'whatsapp' && provider === 'whatsapp_cloud') {
      return this.connectWhatsApp(storeId, sellerId, body);
    }
    if (type === 'tax' && provider === 'taxjar') {
      return this.taxService.connect(storeId, sellerId, body.apiToken);
    }
    if (type === 'shipping' && provider === 'shippo') {
      return this.shippingRatesService.connect(storeId, sellerId, body.apiToken, body.originAddress);
    }
    throw new BadRequestException(`"${provider}" does not support type "${type}"`);
  }

  async updateShippingSettings(storeId: string, sellerId: string, dto: ShippingSettingsInput) {
    await this.assertOwnedStore(storeId, sellerId);
    return this.shippingRatesService.updateSettings(storeId, sellerId, dto);
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
      // Test mode toggle: an explicit `mode` wins; otherwise inferred from the key (Safepay live keys contain "_live_").
      const mode = resolveMode(body.mode, String(secretKey).includes('_live_') ? 'live' : 'sandbox');

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
            // New credentials / mode have never been tested.
            lastVerifiedAt: null,
          },
          $setOnInsert: { webhookToken: randomBytes(32).toString('hex'), isEnabledForCheckout: false },
        },
        { new: true, upsert: true },
      );

      await this.logChange(storeId, sellerId, 'integration.connect', doc, { provider, mode });
      return { success: true, data: this.toPublicView(doc) };
    }

    if (provider === 'jazzcash' || provider === 'payfast') {
      const required = provider === 'jazzcash' ? ['merchantId', 'password', 'integritySalt'] : ['merchantId', 'securedKey'];
      const missing = required.filter((k) => !String(body[k] ?? '').trim());
      if (missing.length) throw new BadRequestException(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required`);
      const credentials: Record<string, string> = {};
      for (const k of required) credentials[k] = String(body[k]).trim();
      const credentialsEncrypted = encryptCredential(JSON.stringify(credentials), 'INTEGRATIONS');
      const mode = resolveMode(body.mode, 'sandbox');
      const label = provider === 'jazzcash' ? 'JazzCash' : 'PayFast';

      const doc = await this.repos.storeIntegrationModel.findOneAndUpdate(
        { storeId, type: 'payment', provider },
        {
          $set: {
            sellerId,
            mode,
            status: 'connected',
            credentialsEncrypted,
            'config.displayName': body.displayName ?? label,
            'config.currency': 'PKR',
            // PayFast shows the merchant name on its hosted page; JazzCash bank/product ids are optional overrides.
            ...(body.merchantName ? { 'config.merchantName': String(body.merchantName).slice(0, 60) } : {}),
            ...(provider === 'jazzcash' && body.bankId ? { 'config.bankId': String(body.bankId).slice(0, 20) } : {}),
            ...(provider === 'jazzcash' && body.productId ? { 'config.productId': String(body.productId).slice(0, 20) } : {}),
            'config.maskedHints': maskCredentials(credentials),
            lastError: null,
            lastVerifiedAt: null,
          },
          $setOnInsert: { webhookToken: randomBytes(32).toString('hex'), isEnabledForCheckout: false },
        },
        { new: true, upsert: true },
      );
      await this.logChange(storeId, sellerId, 'integration.connect', doc, { provider, mode });
      return { success: true, data: this.toPublicView(doc) };
    }

    if (provider === 'bank_transfer') {
      const { bankName, accountTitle, accountNumber, iban, jazzcashNumber, easypaisaNumber, instructions } = body;
      if (!bankName || !accountTitle || !accountNumber) {
        throw new BadRequestException('bankName, accountTitle and accountNumber are required');
      }
      // No credentialsEncrypted — these fields aren't a secret, they're what
      // gets shown to the buyer at checkout so they know where to send money.
      const doc = await this.repos.storeIntegrationModel.findOneAndUpdate(
        { storeId, type: 'payment', provider },
        {
          $set: {
            sellerId,
            mode: 'live',
            status: 'connected',
            credentialsEncrypted: null,
            config: {
              bankName, accountTitle, accountNumber,
              iban: iban ?? null,
              jazzcashNumber: jazzcashNumber ?? null,
              easypaisaNumber: easypaisaNumber ?? null,
              instructions: instructions ?? null,
              currency: 'PKR',
            },
            lastError: null,
          },
          $setOnInsert: { isEnabledForCheckout: false },
        },
        { new: true, upsert: true },
      );

      await this.logChange(storeId, sellerId, 'integration.connect', doc, { provider, mode: 'live' });
      return { success: true, data: this.toPublicView(doc) };
    }

    // Easypaisa has no provider implementation (see providers/easypaisa.provider.ts for why).
    throw new BadRequestException(`"${provider}" is not available yet`);
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
   * Confirms the stored credentials really work. WhatsApp: Meta's `debug_token`. Payment gateways: a real
   * round-trip to the gateway in the integration's own mode (each provider's `testConnection` — Safepay creates a
   * throw-away tracker, PayFast requests an access token, JazzCash sends a signed inquiry).
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
    } else if (integration.type === 'payment' && this.registry.isSupported(integration.provider)) {
      // A REAL call to the gateway with the seller's own credentials in the integration's current mode.
      try {
        const result = await this.registry.resolve(integration.provider).testConnection(toDecryptedPaymentConfig(integration));
        ok = result.ok;
        message = result.message;
      } catch (err: any) {
        ok = false;
        message = `Stored credentials could not be used: ${err?.message ?? 'decryption failed'}`;
      }
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
    patch: { isEnabledForCheckout?: boolean; displayName?: string; webhookSecret?: string; mode?: 'sandbox' | 'live' },
  ) {
    await this.assertOwnedStore(storeId, sellerId);
    const integration = await this.repos.storeIntegrationModel.findOne({ _id: id, storeId });
    if (!integration) throw new NotFoundException('Integration not found');

    const modeChange = (patch.mode === 'live' || patch.mode === 'sandbox') && patch.mode !== integration.mode ? patch.mode : null;
    if (modeChange && integration.type !== 'payment') throw new BadRequestException('Only payment integrations have a test mode');
    const effectiveMode = modeChange ?? integration.mode;
    if (patch.isEnabledForCheckout && effectiveMode === 'live' && (modeChange || !integration.lastVerifiedAt)) {
      throw new BadRequestException('Run a successful test before enabling a live-mode integration for checkout');
    }

    const $set: Record<string, any> = {};
    if (typeof patch.isEnabledForCheckout === 'boolean') $set.isEnabledForCheckout = patch.isEnabledForCheckout;
    if (patch.displayName) $set['config.displayName'] = patch.displayName;
    if (modeChange) {
      // Test <-> live switch (Shopify "Test mode"): sandbox and live credentials differ, so the new mode is untested
      // and is taken out of checkout until the seller tests it.
      $set.mode = modeChange;
      $set.lastVerifiedAt = null;
      $set.lastError = null;
      $set.isEnabledForCheckout = false;
    }

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
