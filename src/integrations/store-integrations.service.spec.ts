/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { StoreIntegrationsService } from './store-integrations.service';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { WhatsAppCloudProvider } from './providers/whatsapp-cloud.provider';
import { StripeConnectService } from '../stripe-connect/stripe-connect.service';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';

const STORE_ID = 'store-1';
const SELLER_ID = 'seller-1';

function ownedStore(overrides: Partial<Record<string, any>> = {}) {
  return { _id: STORE_ID, sellerId: SELLER_ID, isDelete: false, baseCurrency: 'PKR', ...overrides };
}

describe('StoreIntegrationsService', () => {
  let service: StoreIntegrationsService;
  let storeModel: any;
  let storeIntegrationModel: any;
  let activityLogService: ActivityLogService;
  let registry: PaymentProviderRegistry;

  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY: 'test-key-do-not-use-in-prod' };

    storeModel = { findById: jest.fn().mockResolvedValue(ownedStore()) };
    storeIntegrationModel = { findOne: jest.fn(), findOneAndUpdate: jest.fn(), find: jest.fn() };
    const db = { repositories: { storeModel, storeIntegrationModel } } as unknown as DatabaseService;

    activityLogService = { log: jest.fn() } as any;
    registry = { isSupported: jest.fn().mockReturnValue(true) } as any;
    const whatsAppProvider = {} as WhatsAppCloudProvider;
    const stripeConnectService = {} as StripeConnectService;

    service = new StoreIntegrationsService(db, activityLogService, registry, whatsAppProvider, stripeConnectService);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('connect (Safepay) — the webhookSecret sequencing fix', () => {
    it('rejects an ownership mismatch before touching anything', async () => {
      storeModel.findById.mockResolvedValue(ownedStore({ sellerId: 'someone-else' }));
      await expect(
        service.connect(STORE_ID, SELLER_ID, 'payment', 'safepay', { secretKey: 'sk_test_x', clientId: 'c1' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('requires only secretKey and clientId — webhookSecret is NOT required (Safepay only issues one after the webhook URL is registered, which needs this call to happen first)', async () => {
      storeIntegrationModel.findOneAndUpdate.mockImplementation((_filter: any, update: any) =>
        Promise.resolve({ _id: 'int-1', ...update.$set, webhookToken: 'generated-token-abc', config: {} }),
      );

      await expect(
        service.connect(STORE_ID, SELLER_ID, 'payment', 'safepay', { clientId: 'c1' }),
      ).rejects.toThrow('secretKey and clientId are required');

      const result = await service.connect(STORE_ID, SELLER_ID, 'payment', 'safepay', {
        secretKey: 'sk_test_x',
        clientId: 'c1',
      });
      expect(result.success).toBe(true);
    });

    it('stores webhookSecret as null when omitted, and returns the webhookToken so the seller can actually register the webhook URL', async () => {
      let savedUpdate: any;
      storeIntegrationModel.findOneAndUpdate.mockImplementation((_filter: any, update: any) => {
        savedUpdate = update;
        return Promise.resolve({ _id: 'int-1', ...update.$set, webhookToken: 'generated-token-abc', config: update.$set.config ?? {} });
      });

      const result = await service.connect(STORE_ID, SELLER_ID, 'payment', 'safepay', {
        secretKey: 'sk_test_x',
        clientId: 'c1',
      });

      const storedCredentials = JSON.parse(decryptCredential(savedUpdate.$set.credentialsEncrypted, 'INTEGRATIONS'));
      expect(storedCredentials).toEqual({ secretKey: 'sk_test_x', clientId: 'c1', webhookSecret: null });
      expect(result.data.webhookToken).toBe('generated-token-abc');
    });
  });

  describe('update — adding webhookSecret after registering the webhook URL with Safepay (step 4 of the flow)', () => {
    function connectedIntegration(credentials: Record<string, any>) {
      return {
        _id: 'int-1',
        storeId: STORE_ID,
        type: 'payment',
        provider: 'safepay',
        mode: 'sandbox',
        status: 'connected',
        credentialsEncrypted: encryptCredential(JSON.stringify(credentials), 'INTEGRATIONS'),
        config: {},
        webhookToken: 'generated-token-abc',
      };
    }

    it('refuses to add a webhookSecret to an integration with no existing credentials', async () => {
      storeIntegrationModel.findOne.mockResolvedValue({ _id: 'int-1', storeId: STORE_ID, credentialsEncrypted: null });
      await expect(
        service.update(STORE_ID, SELLER_ID, 'int-1', { webhookSecret: 'whsec_new' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('merges the new webhookSecret into the existing credentials without disturbing secretKey/clientId, and re-masks it', async () => {
      const integration = connectedIntegration({ secretKey: 'sk_test_x', clientId: 'c1', webhookSecret: null });
      storeIntegrationModel.findOne.mockResolvedValue(integration);

      let savedUpdate: any;
      storeIntegrationModel.findOneAndUpdate.mockImplementation((_filter: any, update: any) => {
        savedUpdate = update;
        return Promise.resolve({ ...integration, ...update.$set, config: { ...integration.config, ...flattenConfig(update.$set) } });
      });

      const result = await service.update(STORE_ID, SELLER_ID, 'int-1', { webhookSecret: 'whsec_real_value' });

      const merged = JSON.parse(decryptCredential(savedUpdate.$set.credentialsEncrypted, 'INTEGRATIONS'));
      expect(merged).toEqual({ secretKey: 'sk_test_x', clientId: 'c1', webhookSecret: 'whsec_real_value' });
      expect(savedUpdate.$set['config.maskedHints'].webhookSecret).toMatch(/^••••/);
      expect(result.success).toBe(true);
    });
  });
});

function flattenConfig(set: Record<string, any>) {
  const config: Record<string, any> = {};
  for (const [key, value] of Object.entries(set)) {
    if (key.startsWith('config.')) config[key.slice('config.'.length)] = value;
  }
  return config;
}
